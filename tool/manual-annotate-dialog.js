// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2016 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const fs = require('fs');
const readline = require('readline');
const events = require('events');
const seedrandom = require('seedrandom');
const Tp = require('thingpedia');
const ThingTalk = require('thingtalk');

const { AVAILABLE_LANGUAGES } = require('../lib/languages');
const ParserClient = require('./lib/parserclient');
const { DialogueParser, DialogueSerializer } = require('./lib/dialog_parser');
const StreamUtils = require('../lib/stream-utils');
const { readAllLines } = require('./lib/argutils');
const MultiJSONDatabase = require('./lib/multi_json_database');

class Annotator extends events.EventEmitter {
    constructor(rl, dialogues, options) {
        super();

        this._rl = rl;
        this._nextDialogue = dialogues[Symbol.iterator]();

        const tpClient = new Tp.FileClient(options);
        this._schemas = new ThingTalk.SchemaRetriever(tpClient, null, true);
        this._userParser = ParserClient.get(options.user_nlu_server, options.locale);
        this._agentParser = ParserClient.get(options.agent_nlu_server, options.locale);
        this._target = require('../lib/languages/' + options.target_language);

        const simulatorOptions = {
            rng: seedrandom.alea('almond is awesome'),
            locale: options.locale,
            thingpediaClient: tpClient,
            schemaRetriever: this._schemas
        };
        if (options.database_file) {
            this._database = new MultiJSONDatabase(options.database_file);
            simulatorOptions.database = this._database;
        }

        this._simulator = this._target.createSimulator(simulatorOptions);

        this._state = 'loading';

        this._serial = options.offset - 1;

        this._currentDialogue = undefined;
        this._outputDialogue = [];
        this._currentTurnIdx = undefined;
        this._outputTurn = undefined;
        this._currentKey = undefined;
        this._context = undefined;
        this._simulatorState = undefined;
        this._dialogState = undefined;
        this._utterance = undefined;
        this._preprocessed = undefined;
        this._entities = undefined;
        this._candidates = undefined;

        rl.on('line', async (line) => {
            if (this._state === 'done')
                return;

            line = line.trim();

            if (line.length === 0 || this._state === 'loading') {
                rl.prompt();
                return;
            }

            if (line === 'h' || line === '?') {
                this._help();
                return;
            }
            if (line === 'q') {
                this.emit('quit');
                return;
            }

            if (line === 'd' || line.startsWith('d ')) {
                let comment = line.substring(2).trim();
                if (!comment && this._comment)
                    comment = this._comment;

                if (this._outputDialogue.length > 0) {
                    this.emit('learned', {
                        id: this._serial,
                        turns: this._outputDialogue,
                    });
                }

                this.emit('dropped', {
                    id: this._serial,
                    turns: this._currentDialogue,
                    comment: `dropped at turn ${this._outputDialogue.length+1}: ${comment}`
                });
                this._outputDialogue = [];
                this.next();
                return;
            }

            if (this._state === 'code') {
                this._learnThingTalk(line).catch((e) => this.emit('error', e));
                return;
            }

            if (Number.isFinite(parseInt(line))) {
                this._learnNumber(parseInt(line));
            } else if (line === 'n') {
                this._more();
            } else if (line === 'e') {
                this._edit(undefined);
            } else if (line.startsWith('e ')) {
                this._edit(parseInt(line.substring(2).trim()));
            } else if (line === 't') {
                this._state = 'code';
                rl.setPrompt('TT: ');
                rl.prompt();
            } else {
                //console.log('Invalid command');
                //rl.prompt();
                this._learnThingTalk(line).catch((e) => this.emit('error', e));
            }
        });
    }

    _help() {
        console.log('Available commands:');
        console.log('q: quit');
        console.log('d: (done/drop) complete the current dialog and start the next one');
        console.log('<0-9>: make a choice');
        console.log('n: (next) show more choices');
        console.log('e <0-9>: edit a choice');
        console.log('t: (thingtalk) write code directly');
        console.log('? or h: this help');
    }

    async start() {
        if (this._database)
            await this._database.load();
        await this._userParser.start();
        await this._agentParser.start();
    }
    async stop() {
        await this._userParser.start();
        await this._agentParser.start();
    }

    async _learnThingTalk(code) {
        let program;
        try {
            program = await ThingTalk.Grammar.parseAndTypecheck(code, this._schemas);

            const clone = {};
            Object.assign(clone, this._entities);
            ThingTalk.NNSyntax.toNN(program, this._preprocessed, clone, { allocateEntities: true });
        } catch(e) {
            console.log(`${e.name}: ${e.message}`);
            this._rl.setPrompt('TT: ');
            this._rl.prompt();
            return;
        }

        const oldContext = this._context;
        this._context = this._target.computeNewState(this._context, program, this._dialogueState);
        const prediction = this._target.computePrediction(oldContext, this._context, this._dialogueState);
        this._outputTurn[this._currentKey] = prediction.prettyprint();
        this._nextUtterance();
    }

    _edit(i) {
        let program;
        if (i === undefined) {
            program = this._context;
        } else {
            if (Number.isNaN(i) || i < 1 || i > this._candidates.length) {
                console.log('Invalid number');
                this._rl.setPrompt('$ ');
                this._rl.prompt();
                return;
            }
            i -= 1;
            program = this._candidates[i];
        }
        this._state = 'code';
        this._rl.setPrompt('TT: ');
        this._rl.write(program.prettyprint(true).replace(/\n/g, ' '));
        this._rl.prompt();
    }

    _learnNumber(i) {
        if (i < 1 || i > this._candidates.length) {
            console.log('Invalid number');
            this._rl.setPrompt('$ ');
            this._rl.prompt();
            return;
        }
        i -= 1;

        const program = this._candidates[i];
        const oldContext = this._context;
        this._context = this._target.computeNewState(this._context, program, this._dialogueState);
        const prediction = this._target.computePrediction(oldContext, this._context, this._dialogueState);
        this._outputTurn[this._currentKey] = prediction.prettyprint();
        this._nextUtterance();
    }

    _more() {
        if (this._state === 'top3') {
            this._state = 'full';
            console.log(`Sentence #${this._serial+1} (${this._id}): ${this._utterance}`);
            for (let i = 0; i < this._candidates.length; i++)
                console.log(`${i+1}) ${this._candidates[i].code.join(' ')}`);
            this._rl.setPrompt('$ ');
            this._rl.prompt();
        } else {
            this._state = 'code';
            this._rl.setPrompt('TT: ');
            this._rl.prompt();
        }
    }

    next() {
        if (this._outputDialogue.length > 0) {
            this.emit('learned', {
                id: this._serial,
                turns: this._outputDialogue,
            });
        }

        const { value: nextDialogue, done } = this._nextDialogue.next();
        if (done) {
            this.emit('end');
            return;
        }

        if (this._serial > 0)
            console.log();
        console.log(`Dialog #${this._serial+1}`);
        this._serial++;

        this._currentDialogue = nextDialogue;
        this._outputDialogue = [];
        this._context = null;
        this._outputTurn = undefined;
        this._simulatorState = undefined;
        this._currentTurnIdx = -1;
        this._nextTurn();
    }

    async _nextTurn() {
        if (this._outputTurn !== undefined)
            this._outputDialogue.push(this._outputTurn);
        this._currentTurnIdx ++;

        if (this._currentTurnIdx >= this._currentDialogue.length) {
            this.next();
            return;
        }
        if (this._currentTurnIdx > 0) {
            // "execute" the context
            [this._context, this._simulatorState] = await this._simulator.execute(this._context, this._simulatorState);
        }

        const currentTurn = this._currentDialogue[this._currentTurnIdx];

        const contextCode = (this._context ? this._context.prettyprint() : null);
        this._outputTurn = {
            context: contextCode,
            agent: currentTurn.agent,
            agent_target: '',
            user: currentTurn.user,
            user_target: '',
        };

        this._state = 'input';
        this._dialogueState = (this._currentTurnIdx === 0 ? 'user' : 'agent');

        this._utterance = undefined;
        await this._handleUtterance();
    }

    _nextUtterance() {
        if (this._dialogueState === 'agent') {
            this._dialogueState = 'user';
            this._handleUtterance();
        } else {
            this._nextTurn();
        }
    }

    async _handleUtterance() {
        console.log('Context: ' + (this._context ? this._context.prettyprint() : null));

        this._utterance = this._outputTurn[this._dialogueState];
        this._currentKey = this._dialogueState + '_target';

        console.log((this._dialogueState === 'agent' ? 'A: ' : 'U: ') + this._utterance);
        this._state = 'loading';

        let contextCode, contextEntities;
        if (this._context !== null) {
            const context = this._target.prepareContextForPrediction(this._context, this._dialogueState);
            [contextCode, contextEntities] = this._target.serializeNormalized(context);
        } else {
            contextCode = ['null'];
            contextEntities = {};
        }

        const parser = this._dialogueState === 'agent' ? this._agentParser : this._userParser;
        const parsed = await parser.sendUtterance(this._utterance, false, contextCode, contextEntities);

        this._state = 'top3';
        this._preprocessed = parsed.tokens.join(' ');
        this._entities = parsed.entities;
        this._candidates = (await Promise.all(parsed.candidates.map(async (cand) => {
            try {
                const program = ThingTalk.NNSyntax.fromNN(cand.code, parsed.entities);
                await program.typecheck(this._schemas);

                // convert the program to NN syntax once, which will force the program to be syntactically normalized
                // (and therefore rearrange slot-fill by name rather than Thingpedia order)
                ThingTalk.NNSyntax.toNN(program, '', {}, { allocateEntities: true });
                return program;
            } catch(e) {
                return null;
            }
        }))).filter((c) => c !== null);

        if (this._candidates.length > 0) {
            for (var i = 0; i < 3 && i < this._candidates.length; i++)
                console.log(`${i+1}) ${this._candidates[i].prettyprint()}`);
        } else {
            console.log(`No candidates for this program`);
        }
        this._rl.setPrompt('$ ');
        this._rl.prompt();
    }
}

module.exports = {
    initArgparse(subparsers) {
        const parser = subparsers.addParser('manual-annotate-dialog', {
            addHelp: true,
            description: `Interactively annotate a dialog dataset, by annotating each sentence turn-by-turn.`
        });
        parser.addArgument('--annotated', {
            required: true,
        });
        parser.addArgument('--dropped', {
            required: true,
        });
        parser.addArgument('--offset', {
            required: false,
            type: parseInt,
            defaultValue: 1,
            help: `Start from the nth dialogue of the input tsv file.`
        });
        parser.addArgument(['-l', '--locale'], {
            required: false,
            defaultValue: 'en-US',
            help: `BGP 47 locale tag of the natural language being processed (defaults to en-US).`
        });
        parser.addArgument('--thingpedia', {
            required: true,
            help: 'Path to ThingTalk file containing class definitions.'
        });
        parser.addArgument(['-t', '--target-language'], {
            required: false,
            defaultValue: 'dlgthingtalk',
            choices: AVAILABLE_LANGUAGES,
            help: `The programming language to generate`
        });
        parser.addArgument('--database-file', {
            required: false,
            help: `Path to a file pointing to JSON databases used to simulate queries.`,
        });
        parser.addArgument('--user-nlu-server', {
            required: false,
            defaultValue: 'http://127.0.0.1:8400',
            help: `The URL of the natural language server to parse user utterances. Use a file:// URL pointing to a model directory to use a local instance of genienlp.`
        });
        parser.addArgument('--agent-nlu-server', {
            required: false,
            defaultValue: 'http://127.0.0.1:8400',
            help: `The URL of the natural language server to parse agent utterances. Use a file:// URL pointing to a model directory to use a local instance of genienlp.`
        });
        parser.addArgument('input_file', {
            nargs: '+',
            type: fs.createReadStream,
            help: 'Input dialog file'
        });
    },

    async execute(args) {
        let dialogues = await readAllLines(args.input_file, '====')
            .pipe(new DialogueParser({ withAnnotations: false }))
            .pipe(new StreamUtils.ArrayAccumulator())
            .read();

        if (args.offset > 1)
            dialogues = dialogues.slice(args.offset-1);

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.setPrompt('$ ');

        function quit() {
            learned.end();
            dropped.end();
            rl.close();
            //process.exit();
        }

        const annotator = new Annotator(rl, dialogues, args);
        await annotator.start();

        const learned = new DialogueSerializer({ annotations: true });
        learned.pipe(fs.createWriteStream(args.annotated, { flags: (args.offset > 1 ? 'a' : 'w') }));
        const dropped = new DialogueSerializer({ annotations: false });
        dropped.pipe(fs.createWriteStream(args.dropped, { flags: (args.offset > 1 ? 'a' : 'w') }));

        annotator.on('end', quit);
        annotator.on('learned', (dlg) => {
            learned.write(dlg);
        });
        annotator.on('dropped', (dlg) => {
            dropped.write(dlg);
        });
        annotator.on('quit', quit);
        rl.on('SIGINT', quit);
        annotator.next();
        //process.stdin.on('end', quit);

        await Promise.all([
            StreamUtils.waitFinish(learned),
            StreamUtils.waitFinish(dropped),
        ]);
        await annotator.stop();
        process.exit();
    }
};
