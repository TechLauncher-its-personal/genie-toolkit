// -*- mode: typescript; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2020 The Board of Trustees of the Leland Stanford Junior University
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>


import assert from 'assert';

import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { Ast } from 'thingtalk';
import interpolate from 'string-interp';
import AsyncQueue from 'consumer-queue';

import { getProgramIcon } from '../utils/icons';
import * as ThingTalkUtils from '../utils/thingtalk';
import { EntityMap } from '../utils/entity-utils';
import type Engine from '../engine';
import * as ParserClient from '../prediction/parserclient';

import ValueCategory from './value-category';
import QueueItem from './dialogue_queue';
import {
    UserInput,
    PlatformData
} from './user-input';
import { CancellationError } from './errors';

import * as Helpers from './helpers';
import DialoguePolicy from './dialogue_policy';
import type Conversation from './conversation';
import TextFormatter from './card-output/text-formatter';
import CardFormatter, { FormattedChunk } from './card-output/card-formatter';

import ExecutionDialogueAgent from './execution_dialogue_agent';

const ENABLE_SUGGESTIONS = false;

// TODO: load the policy.yaml file instead
const POLICY_NAME = 'org.thingpedia.dialogue.transaction';
const TERMINAL_STATES = [
    'sys_end', 'sys_action_success'
];

enum CommandAnalysisType {
    // special commands
    STOP,
    NEVERMIND,
    WAKEUP,
    DEBUG,

    // some sort of command
    IN_DOMAIN_COMMAND,
    OUT_OF_DOMAIN_COMMAND,
    PARSE_FAILURE,

    // ignore this command and do nothing
    IGNORE
}

interface CommandAnalysisResult {
    type : CommandAnalysisType;

    // not null if this command was generated as a ThingTalk $answer()
    // only used by legacy ask() methods
    answer : Ast.Value|number|null;

    // the user target
    parsed : Ast.Input|null;
}

interface DialogueLoopOptions {
    nluServerUrl : string|undefined;
    nlgServerUrl : string|undefined;
    debug : boolean;
}

export default class DialogueLoop {
    conversation : Conversation;
    engine : Engine;

    private _nlu : ParserClient.ParserClient;
    private _nlg : ParserClient.ParserClient;
    private _textFormatter : TextFormatter;
    private _cardFormatter : CardFormatter;

    private _userInputQueue : AsyncQueue<UserInput>;
    private _notifyQueue : AsyncQueue<QueueItem>;
    private _prefs : Tp.Preferences;
    private _agent : ExecutionDialogueAgent;
    private _policy : DialoguePolicy;
    private _debug : boolean;

    icon : string|null;
    expecting : ValueCategory|null;
    platformData : PlatformData;
    private _raw = false;
    private _choices : string[];
    private _dialogueState : ThingTalk.Ast.DialogueState|null;
    private _executorState : undefined;
    private _lastNotificationApp : string|undefined;

    private _stopped = false;
    private _mgrResolve : (() => void)|null;
    private _mgrPromise : Promise<void>|null;

    constructor(conversation : Conversation,
                engine : Engine,
                options : DialogueLoopOptions) {
        this._userInputQueue = new AsyncQueue();
        this._notifyQueue = new AsyncQueue();

        this._debug = options.debug;
        this.conversation = conversation;
        this.engine = engine;
        this._prefs = engine.platform.getSharedPreferences();
        this._nlu = ParserClient.get(options.nluServerUrl || undefined, engine.platform.locale, engine.platform,
            undefined, engine.thingpedia);
        this._nlg = ParserClient.get(options.nlgServerUrl || undefined, engine.platform.locale, engine.platform);

        this._textFormatter = new TextFormatter(engine.platform.locale, engine.platform.timezone, engine.schemas);
        this._cardFormatter = new CardFormatter(engine.platform.locale, engine.platform.timezone, engine.schemas);
        this.icon = null;
        this.expecting = null;
        this._choices = [];
        this.platformData = {};

        this._mgrResolve = null;
        this._mgrPromise = null;

        this._agent = new ExecutionDialogueAgent(engine, this, options.debug);
        this._policy = new DialoguePolicy({
            thingpedia: conversation.thingpedia,
            schemas: conversation.schemas,
            locale: conversation.locale,
            timezone: engine.platform.timezone,
            rng: conversation.rng,
            debug : this._debug
        });
        this._dialogueState = null; // thingtalk dialogue state
        this._executorState = undefined; // private object managed by DialogueExecutor
        this._lastNotificationApp = undefined;
    }

    get _() : (x : string) => string {
        return this.conversation._;
    }
    get isAnonymous() : boolean {
        return this.conversation.isAnonymous;
    }
    get hasDebug() : boolean {
        return this._debug;
    }

    debug(...args : unknown[]) {
        if (!this._debug)
            return;
        console.log(...args);
    }

    interpolate(msg : string, args : Record<string, unknown>) : string {
        return interpolate(msg, args, {
            locale: this.conversation.locale,
            timezone: this.conversation.timezone
        })||'';
    }

    async nextCommand() : Promise<UserInput> {
        await this.conversation.sendAskSpecial();
        this._mgrPromise = null;
        this._mgrResolve!();
        const intent = await this._userInputQueue.pop();
        this.platformData = intent.platformData;
        return intent;
    }

    private _checkPolicy(policyName : string) {
        if (policyName !== POLICY_NAME) {
            // TODO we should download the policy from Thingpedia
            throw new Error(`Invalid dialogue policy ${policyName}`);
        }
    }

    private _getSpecialThingTalkType(input : Ast.Input) : CommandAnalysisType {
        if (input instanceof Ast.ControlCommand) {
            if (input.intent instanceof Ast.SpecialControlIntent) {
                switch (input.intent.type) {
                case 'stop':
                    return CommandAnalysisType.STOP;
                case 'nevermind':
                    return CommandAnalysisType.NEVERMIND;
                case 'wakeup':
                    return CommandAnalysisType.WAKEUP;
                case 'debug':
                    return CommandAnalysisType.DEBUG;
                case 'failed':
                    return CommandAnalysisType.PARSE_FAILURE;
                }
            }
        }

        // anything else is automatically in-domain
        return CommandAnalysisType.IN_DOMAIN_COMMAND;
    }

    private _maybeGetThingTalkAnswer(input : Ast.Input) : Ast.Value|number|null {
        if (input instanceof Ast.ControlCommand) {
            if (input.intent instanceof Ast.SpecialControlIntent) {
                switch (input.intent.type) {
                case 'yes':
                case 'no':
                    return new Ast.Value.Boolean(input.intent.type === 'yes');
                }
            } else if (input.intent instanceof Ast.AnswerControlIntent
                       || input.intent instanceof Ast.ChoiceControlIntent) {
                return input.intent.value;
            }
        }
        return null;
    }

    private _prepareContextForPrediction(state : Ast.DialogueState|null, forSide : 'user'|'agent') : [string[], EntityMap] {
        const prepared = ThingTalkUtils.prepareContextForPrediction(state, forSide);
        return ThingTalkUtils.serializeNormalized(prepared);
    }

    private async _analyzeCommand(command : UserInput) : Promise<CommandAnalysisResult> {
        if (command.type === 'thingtalk') {
            const type = this._getSpecialThingTalkType(command.parsed);
            return {
                type,
                answer: this._maybeGetThingTalkAnswer(command.parsed),
                parsed: type === CommandAnalysisType.IN_DOMAIN_COMMAND ? command.parsed : null
            };
        }

        // ok so this was a natural language

        if (this._raw) {
            // in "raw mode", all natural language becomes an answer
            let value;
            if (this.expecting === ValueCategory.Location)
                value = new Ast.LocationValue(new Ast.UnresolvedLocation(command.utterance));
            else
                value = new Ast.Value.String(command.utterance);
            return {
                type: CommandAnalysisType.IN_DOMAIN_COMMAND,
                answer: value,
                parsed: new Ast.ControlCommand(null, new Ast.AnswerControlIntent(null, value))
            };
        }

        // alright, let's ask parser first then
        let nluResult : ParserClient.PredictionResult;
        try {
            const [contextCode, contextEntities] = this._prepareContextForPrediction(this._dialogueState, 'user');

            nluResult = await this._nlu.sendUtterance(command.utterance, contextCode, contextEntities, {
                expect: this.expecting ? String(this.expecting) : undefined,
                choices: this._choices,
                store: this._prefs.get('sabrina-store-log') as string || 'no'
            });
        } catch(e) {
            if (e.code === 'EHOSTUNREACH' || e.code === 'ETIMEDOUT') {
                await this.reply(this._("Sorry, I cannot contact the Almond service. Please check your Internet connection and try again later."), null);
                throw new CancellationError();
            } else if (typeof e.code === 'number' && (e.code === 404 || e.code >= 500)) {
                await this.reply(this._("Sorry, there seems to be a problem with the Almond service at the moment. Please try again later."), null);
                throw new CancellationError();
            } else {
                throw e;
            }
        }

        // parse all code sequences into an Intent
        // this will correctly filter out anything that does not parse
        if (nluResult.candidates.length > 0)
            this.debug('Analyzed message into ' + nluResult.candidates[0].code.join(' '));
        else
            this.debug('Failed to analyze message');
        const candidates = await Promise.all(nluResult.candidates.map(async (candidate, beamposition) => {
            let parsed;
            try {
                parsed = await ThingTalkUtils.parsePrediction(candidate.code, nluResult.entities, {
                    thingpediaClient: this.engine.thingpedia,
                    schemaRetriever: this.engine.schemas,
                    loadMetadata: true,
                }, true);
            } catch(e) {
                // Likely, a type error in the ThingTalk code; not a big deal, but we still log it
                console.log(`Failed to parse beam ${beamposition}: ${e.message}`);
                parsed = new Ast.ControlCommand(null, new Ast.SpecialControlIntent(null, 'failed'));
            }
            return { parsed, score: candidate.score };
        }));
        // ensure that we always have at least one candidate by pushing $failed at the end
        candidates.push({ parsed: new Ast.ControlCommand(null, new Ast.SpecialControlIntent(null, 'failed')), score: 0 });

        // ignore all candidates with score==Infinity that we failed to parse
        // (these are exact matches that correspond to skills not available for
        // this user)
        let i = 0;
        let choice = candidates[i];
        let type = this._getSpecialThingTalkType(choice.parsed);
        while (i < candidates.length-1 && type === CommandAnalysisType.PARSE_FAILURE && choice.score === 'Infinity') {
            i++;
            choice = candidates[i];
            type = this._getSpecialThingTalkType(choice.parsed);
        }

        if (type === CommandAnalysisType.PARSE_FAILURE)
            this.conversation.stats.hit('sabrina-failure');
        else
            this.conversation.stats.hit('sabrina-command-good');

        return {
            type,
            answer: this._maybeGetThingTalkAnswer(choice.parsed),
            parsed: type === CommandAnalysisType.IN_DOMAIN_COMMAND ? choice.parsed : null
        };
    }

    private async _getFallbackExamples(command : string) {
        const dataset = await this.conversation.thingpedia.getExamplesByKey(command);
        const examples = ENABLE_SUGGESTIONS ? await Helpers.loadExamples(dataset, this.conversation.schemas, 5) : [];

        if (examples.length === 0) {
            await this.reply(this._("Sorry, I did not understand that."));
            return;
        }

        this.conversation.stats.hit('sabrina-fallback-buttons');

        // don't sort the examples, they come already sorted from Thingpedia

        await this.reply(this._("Sorry, I did not understand that. Try the following instead:"));
        for (const ex of examples)
            this.replyButton(Helpers.presentExample(this, ex.utterance), JSON.stringify(ex.target));
    }

    private _useNeuralNLG() : boolean {
        return this._prefs.get('experimental-use-neural-nlg') as boolean;
    }

    private async _doAgentReply() : Promise<[ValueCategory|null, number]> {
        const oldState = this._dialogueState;

        const policyResult = await this._policy.chooseAction(this._dialogueState);
        if (!policyResult) {
            await this.fail();
            throw new CancellationError();
        }

        let expect, utterance, numResults;
        if (this._useNeuralNLG()) {
            [this._dialogueState, expect, , numResults] = policyResult;

            const policyPrediction = ThingTalkUtils.computeNewState(oldState, this._dialogueState, 'agent');
            this.debug(`Agent act:`);
            this.debug(policyPrediction.prettyprint());

            const [contextCode, contextEntities] = this._prepareContextForPrediction(this._dialogueState, 'agent');

            const [targetAct,] = ThingTalkUtils.serializeNormalized(policyPrediction, contextEntities);
            const result = await this._nlg.generateUtterance(contextCode, contextEntities, targetAct);
            utterance = result[0].answer;
        } else {
            [this._dialogueState, expect, utterance, numResults] = policyResult;
        }

        this.icon = getProgramIcon(this._dialogueState!);
        await this.reply(utterance);
        if (expect === null && TERMINAL_STATES.includes(this._dialogueState!.dialogueAct))
            throw new CancellationError();

        return [expect, numResults];
    }

    private async _handleUICommand(type : CommandAnalysisType.STOP|CommandAnalysisType.NEVERMIND|CommandAnalysisType.DEBUG|CommandAnalysisType.WAKEUP) {
        switch (type) {
        case CommandAnalysisType.STOP:
            // stop means cancel, but without a failure message
            throw new CancellationError();

        case CommandAnalysisType.NEVERMIND:
            await this.reply(this._("Sorry I couldn't help on that."));
            throw new CancellationError();

        case CommandAnalysisType.DEBUG:
            await this.reply("Current State:\n" + (this._dialogueState ? this._dialogueState.prettyprint() : "null"));
            break;

        case CommandAnalysisType.WAKEUP:
            // "wakeup" means the user said "hey almond" without anything else,
            // or said "hey almond wake up", or triggered one of the LaunchIntents
            // in Google Assistant or Alexa, or similar "opening" statements
            // we show the welcome message if the current state is null,
            // and do nothing otherwise
            if (this._dialogueState === null) {
                this._showWelcome();
                // keep the microphone open for a while
                await this.setExpected(ValueCategory.Command);
            }
        }
    }

    private async _handleUserInput(command : UserInput) {
        for (;;) {
            const analyzed = await this._analyzeCommand(command);

            switch (analyzed.type) {
            case CommandAnalysisType.STOP:
            case CommandAnalysisType.NEVERMIND:
            case CommandAnalysisType.DEBUG:
            case CommandAnalysisType.WAKEUP:
                await this._handleUICommand(analyzed.type);
                break;

            case CommandAnalysisType.PARSE_FAILURE:
                await this._getFallbackExamples(command.type === 'command' ? command.utterance : '');
                break;

            case CommandAnalysisType.OUT_OF_DOMAIN_COMMAND:
                // TODO dispatch this out
                await this.reply(this._("Sorry, I don't know how to do that yet."));
                throw new CancellationError();

            default: {
                // everything else is an in-domain command
                const prediction = await ThingTalkUtils.inputToDialogueState(this._policy, this._dialogueState, analyzed.parsed!);
                if (prediction === null) {
                    // the command does not make sense in the current state
                    // do nothing and keep the current state
                    // (this can only occur with commands caught by the exact
                    // matcher like "yes" or "no")
                    await this.fail();
                    break;
                }

                const terminated = await this._handleNormalDialogueCommand(prediction);
                if (terminated)
                    return;
            }
            }

            command = await this.nextCommand();
        }
    }

    private async _handleNormalDialogueCommand(prediction : Ast.DialogueState) : Promise<boolean> {
        this._dialogueState = ThingTalkUtils.computeNewState(this._dialogueState, prediction, 'user');
        this._checkPolicy(this._dialogueState.policy);
        this.icon = getProgramIcon(this._dialogueState);

        //this.debug(`Before execution:`);
        //this.debug(this._dialogueState.prettyprint());

        const { newDialogueState, newExecutorState, newResults } = await this._agent.execute(this._dialogueState, this._executorState);
        this._dialogueState = newDialogueState;
        this._executorState = newExecutorState;
        this.debug(`Execution state:`);
        this.debug(this._dialogueState!.prettyprint());

        const [expect, numResults] = await this._doAgentReply();

        for (const [outputType, outputValue] of newResults.slice(0, numResults)) {
            const formatted = await this._cardFormatter.formatForType(outputType, outputValue, { removeText: true });

            for (const card of formatted)
                await this.replyCard(card);
        }

        await this.setExpected(expect);
        return expect === null;
    }

    private async _showNotification(appId : string,
                                    icon : string|null,
                                    outputType : string,
                                    outputValue : Record<string, unknown>) {
        let app;
        if (appId !== undefined)
            app = this.conversation.apps.getApp(appId);
        else
            app = undefined;

        const messages = await this._textFormatter.formatForType(outputType, outputValue, 'messages');
        if (app !== undefined && app.isRunning && appId !== this._lastNotificationApp &&
            (messages.length === 1 && typeof messages[0] === 'string')) {
            await this.replyInterp(this._("Notification from ${app}: ${message}"), {
                app: app.name,
                message: messages[0]
            }, icon);
        } else {
            if (app !== undefined && app.isRunning && appId !== this._lastNotificationApp)
                await this.replyInterp(this._("Notification from ${app}"), { app: app.name }, icon);
            for (const msg of messages)
                await this.replyCard(msg, icon);
        }
    }

    private async _showAsyncError(appId : string,
                                  icon : string|null,
                                  error : Error) {
        let app;
        if (appId !== undefined)
            app = this.conversation.apps.getApp(appId);
        else
            app = undefined;

        const errorMessage = Helpers.formatError(this, error);
        console.log('Error from ' + appId, error);

        if (app !== undefined && app.isRunning)
            await this.replyInterp(this._("${app} had an error: ${error}."), { app: app.name, error: errorMessage }, icon);
        else
            await this.replyInterp(this._("Sorry, that did not work: ${error}."), { error: errorMessage }, icon);
    }

    private async _handleAPICall(call : QueueItem) {
        if (call instanceof QueueItem.Notification) {
            await this._showNotification(call.appId, call.icon, call.outputType, call.outputValue);
            this._lastNotificationApp = call.appId;
        } else if (call instanceof QueueItem.Error) {
            await this._showAsyncError(call.appId, call.icon, call.error);
            this._lastNotificationApp = call.appId;
        }
    }

    private async _showWelcome() {
        await this._doAgentReply();
        // reset the dialogue state here; if we don't, we we'll see sys_greet as an agent
        // dialogue act; this is never seen in training, because in training the user speaks
        // first, so it confuses the neural network
        this._dialogueState = null;
        // the utterance ends with "what can i do for you?", which is expect = 'generic'
        // but we don't want to keep the microphone open here, we want to go back to wake-word mode
        // so we unconditionally close the round here
        await this.setExpected(null);
    }

    private async _loop(showWelcome : boolean) {
        // if we want to show the welcome message, we run the policy on the `null` state, which will return the sys_greet intent
        if (showWelcome)
            await this._showWelcome();

        while (!this._stopped) {
            const item = await this.nextQueueItem();
            try {
                if (item instanceof QueueItem.UserInput) {
                    this._lastNotificationApp = undefined;
                    await this._handleUserInput(item.command);
                } else {
                    await this._handleAPICall(item);
                    this._dialogueState = null;
                }
            } catch(e) {
                if (e.code === 'ECANCELLED') {
                    this.icon = null;
                    this._dialogueState = null;
                    await this.setExpected(null);
                } else {
                    if (item instanceof QueueItem.UserInput) {
                        await this.replyInterp(this._("Sorry, I had an error processing your command: ${error}."), {//"
                            error: Helpers.formatError(this, e)
                        });
                    } else {
                        await this.replyInterp(this._("Sorry, that did not work: ${error}."), {
                            error: Helpers.formatError(this, e)
                        });
                    }
                    console.error(e);
                }
            }
        }
    }

    get dialogueState() : ThingTalk.Ast.DialogueState|null {
        return this._dialogueState;
    }

    set dialogueState(newState : ThingTalk.Ast.DialogueState|null) {
        this._dialogueState = newState;
    }

    async nextQueueItem() : Promise<QueueItem> {
        this.setExpected(null);
        await this.conversation.sendAskSpecial();
        this._mgrPromise = null;
        this._mgrResolve!();
        const queueItem = await this._notifyQueue.pop();
        if (queueItem instanceof QueueItem.UserInput)
            this.platformData = queueItem.command.platformData;
        else
            this.platformData = {};
        return queueItem;
    }

    async lookingFor() {
        if (this.expecting === null) {
            await this.reply(this._("In fact, I did not ask for anything at all!"));
        } else if (this.expecting === ValueCategory.YesNo) {
            await this.reply(this._("Sorry, I need you to confirm the last question first."));
        } else if (this.expecting === ValueCategory.MultipleChoice) {
            await this.reply(this._("Could you choose one of the following?"));
            await this._resendChoices();
        } else if (this.expecting === ValueCategory.Measure) {
            await this.reply(this._("Could you give me a measurement?"));
        } else if (this.expecting === ValueCategory.Number) {
            await this.reply(this._("Could you give me a number?"));
        } else if (this.expecting === ValueCategory.Date) {
            await this.reply(this._("Could you give me a date?"));
        } else if (this.expecting === ValueCategory.Time) {
            await this.reply(this._("Could you give me a time of day?"));
        } else if (this.expecting === ValueCategory.Picture) {
            await this.reply(this._("Could you upload a picture?"));
        } else if (this.expecting === ValueCategory.Location) {
            await this.reply(this._("Could you give me a place?"));
        } else if (this.expecting === ValueCategory.PhoneNumber) {
            await this.reply(this._("Could you give me a phone number?"));
        } else if (this.expecting === ValueCategory.EmailAddress) {
            await this.reply(this._("Could you give me an email address?"));
        } else if (this.expecting === ValueCategory.RawString || this.expecting === ValueCategory.Password) {
            // ValueCategory.RawString puts Almond in raw mode,
            // so we accept almost everything
            // but this will happen if the user clicks a button
            // or upload a picture
            await this.reply(this._("Which is interesting, because I'll take anything at all. Just type your mind!"));
        } else if (this.expecting === ValueCategory.Command) {
            await this.reply(this._("I'm looking for a command."));
        } else {
            await this.reply(this._("In fact, I'm not even sure what I asked. Sorry!"));
        }
    }

    async fail(msg ?: string) {
        if (this.expecting === null) {
            if (msg) {
                await this.replyInterp(this._("Sorry, I did not understand that: ${error}. Can you rephrase it?"), {
                    error: msg
                });
            } else {
                await this.reply(this._("Sorry, I did not understand that. Can you rephrase it?"));
            }
        } else {
            if (msg)
                await this.replyInterp(this._("Sorry, I did not understand that: ${error}."), { error: msg });
            else
                await this.reply(this._("Sorry, I did not understand that."));
        }
        throw new CancellationError();
    }

    setExpected(expected : ValueCategory|null, raw = (expected === ValueCategory.RawString || expected === ValueCategory.Password)) {
        if (expected === undefined)
            throw new TypeError();
        this.expecting = expected;
        this._raw = raw;
        const [contextCode, contextEntities] = this._prepareContextForPrediction(this._dialogueState, 'user');
        this.conversation.setExpected(expected, { code: contextCode, entities: contextEntities });
    }

    /**
     * Ask a question to the user.
     *
     * This is a legacy method used for certain scripted interactions.
     */
    async ask(expected : ValueCategory.PhoneNumber|ValueCategory.EmailAddress|ValueCategory.Location|ValueCategory.Time,
              question : string,
              args ?: Record<string, unknown>) : Promise<ThingTalk.Ast.Value> {
        await this.replyInterp(question, args);
        // force the question to occur in raw mode for locations
        // because otherwise we send it to the parser and the parser will
        // likely misbehave as it's a state that we've never seen in training
        await this.setExpected(expected, expected === ValueCategory.Location);

        let analyzed = await this._analyzeCommand(await this.nextCommand());
        while (analyzed.answer === null || typeof analyzed.answer === 'number' ||
               ValueCategory.fromType(analyzed.answer.getType()) !== expected) {
            switch (analyzed.type) {
            case CommandAnalysisType.STOP:
            case CommandAnalysisType.NEVERMIND:
            case CommandAnalysisType.DEBUG:
            case CommandAnalysisType.WAKEUP:
                await this._handleUICommand(analyzed.type);
                break;

            default:
                await this.fail();
                await this.lookingFor();
            }

            analyzed = await this._analyzeCommand(await this.nextCommand());
        }
        return analyzed.answer;
    }

    async askChoices(question : string, choices : string[]) : Promise<number> {
        await this.reply(question);
        this.setExpected(ValueCategory.MultipleChoice);
        this._choices = choices;
        for (let i = 0; i < choices.length; i++)
            await this.conversation.sendChoice(i, choices[i]);

        let analyzed = await this._analyzeCommand(await this.nextCommand());
        while (analyzed.answer === null || typeof analyzed.answer !== 'number'
               || analyzed.answer < 0 || analyzed.answer >= choices.length) {
            switch (analyzed.type) {
            case CommandAnalysisType.STOP:
            case CommandAnalysisType.NEVERMIND:
            case CommandAnalysisType.DEBUG:
            case CommandAnalysisType.WAKEUP:
                await this._handleUICommand(analyzed.type);
                break;

            default:
                await this.fail();
                await this.lookingFor();
            }

            analyzed = await this._analyzeCommand(await this.nextCommand());
        }
        return analyzed.answer;
    }
    private async _resendChoices() {
        if (this.expecting !== ValueCategory.MultipleChoice)
            console.log('UNEXPECTED: sendChoice while not expecting a MultipleChoice');

        for (let idx = 0; idx < this._choices.length; idx++)
            await this.conversation.sendChoice(idx, this._choices[idx]);
    }

    async replyInterp(msg : string, args ?: Record<string, unknown>, icon : string|null = null) {
        if (args === undefined)
            return this.reply(msg, icon);
        else
            return this.reply(this.interpolate(msg, args), icon);
    }

    async reply(msg : string, icon ?: string|null) {
        await this.conversation.sendReply(msg, icon || this.icon);
    }

    async replyCard(message : FormattedChunk, icon ?: string|null) {
        if (typeof message === 'string') {
            await this.reply(message, icon);
        } else if (message.type === 'picture') {
            if (message.url === undefined)
                return;
            await this.conversation.sendPicture(message.url, icon || this.icon);
        } else if (message.type === 'rdl') {
            await this.conversation.sendRDL(message, icon || this.icon);
        } else if (message.type === 'button') {
            const loaded = await Helpers.loadSuggestedProgram(message.code, this.conversation.schemas);
            await this.replyButton(message.title, JSON.stringify(loaded));
        } else {
            await this.conversation.sendResult(message, icon || this.icon);
        }
    }

    async replyButton(text : string, json : string) {
        await this.conversation.sendButton(text, json);
    }

    async replyLink(title : string, url : string) {
        await this.conversation.sendLink(title, url);
    }

    private _isInDefaultState() : boolean {
        return this._notifyQueue.hasWaiter();
    }

    dispatchNotify(appId : string, icon : string|null, outputType : string, outputValue : Record<string, unknown>) {
        const item = new QueueItem.Notification(appId, icon, outputType, outputValue);
        this._pushQueueItem(item);
    }
    dispatchNotifyError(appId : string, icon : string|null, error : Error) {
        const item = new QueueItem.Error(appId, icon, error);
        this._pushQueueItem(item);
    }

    async start(showWelcome : boolean) {
        await this._nlu.start();
        await this._nlg.start();

        const promise = this._waitNextCommand();
        this._loop(showWelcome).then(() => {
            throw new Error('Unexpected end of dialog loop');
        }, (err) => {
            console.error('Uncaught error in dialog loop', err);
            throw err;
        });
        return promise;
    }

    async stop() {
        this._stopped = true;

        // wait until the dialog is ready to accept commands, then inject
        // a cancellation error
        await this._mgrPromise;
        assert(this._mgrPromise === null);

        if (this._isInDefaultState())
            this._notifyQueue.cancelWait(new CancellationError());
        else
            this._userInputQueue.cancelWait(new CancellationError());

        await this._nlu.stop();
        await this._nlg.stop();
    }

    async reset() {
        // wait until the dialog is ready to accept commands
        await this._mgrPromise;
        assert(this._mgrPromise === null);

        if (this._isInDefaultState())
            this._notifyQueue.cancelWait(new CancellationError());
        else
            this._userInputQueue.cancelWait(new CancellationError());
    }

    private _pushQueueItem(item : QueueItem) {
        // ensure that we have something to wait on before the next
        // command is handled
        if (!this._mgrPromise)
            this._waitNextCommand();

        this._notifyQueue.push(item);
    }

    /**
     * Returns a promise that will resolve when the dialogue loop is
     * ready to accept the next command from the user.
     */
    private _waitNextCommand() : Promise<void> {
        const promise = new Promise<void>((callback, errback) => {
            this._mgrResolve = callback;
        });
        this._mgrPromise = promise;
        return promise;
    }

    pushCommand(command : UserInput) {
        this._pushQueueItem(new QueueItem.UserInput(command));
    }

    async handleCommand(command : UserInput) : Promise<void> {
        // wait until the dialog is ready to accept commands
        await this._mgrPromise;
        assert(this._mgrPromise === null);

        const promise = this._waitNextCommand();

        if (this._isInDefaultState())
            this.pushCommand(command);
        else
            this._userInputQueue.push(command);

        return promise;
    }
}
