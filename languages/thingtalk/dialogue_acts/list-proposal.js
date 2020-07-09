// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2020 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const assert = require('assert');

const ThingTalk = require('thingtalk');
const Ast = ThingTalk.Ast;

const C = require('../ast_manip');

const {
    getActionInvocation,
    makeAgentReply,
    makeSimpleState,
    addActionParam,
    addAction,
    addQuery,
} = require('../state_manip');
const {
    isInfoPhraseCompatibleWithResult,
    findChainParam
} = require('./common');
const {
    queryRefinement,
    refineFilterToAnswerQuestionOrChangeFilter,
    combinePreambleAndRequest,
    proposalReply,
} = require('./refinement-helpers');

function checkListProposal(nameList, info) {
    const { ctx, results } = nameList;
    const resultType = results[0].value.id.getType();

    if (info !== null) {
        const idType = info.schema.getArgType('id');

        if (!idType || !idType.equals(resultType))
            return null;

        for (let result of results) {
            if (!isInfoPhraseCompatibleWithResult(result, info))
                return null;
        }
    } else {
        if (ctx.resultInfo.projection !== null)
            return null;
    }

    const action = ctx.nextInfo && ctx.nextInfo.isAction ? getActionInvocation(ctx.next) : null;
    return [results, info, action];
}

function addActionToListProposal(nameList, action) {
    const { ctx, results } = nameList;
    const resultType = results[0].value.id.getType();
    if (!C.hasArgumentOfType(action, resultType))
        return null;
    const ctxAction = ctx.nextInfo && ctx.nextInfo.isAction ? getActionInvocation(ctx.next) : null;
    if (ctxAction && !C.isSameFunction(ctxAction.schema, action.schema))
        return null;

    return [results, null, action];
}

function makeListProposalReply(ctx, proposal) {
    const [results, /*info*/, action] = proposal;
    const dialogueAct = results.length === 2 ? 'sys_recommend_two' : 'sys_recommend_three';
    if (action === null)
        return makeAgentReply(ctx, makeSimpleState(ctx, dialogueAct, null), proposal);
    else
        return makeAgentReply(ctx, addAction(ctx, dialogueAct, action, 'proposed'), proposal);
}

function positiveListProposalReply(ctx, [name, acceptedAction, mustHaveAction]) {
    // if actionProposal === null the flow is roughly
    //
    // U: hello i am looking for a restaurant
    // A: how about the ... or the ... ?
    // U: I like the ... bla
    //
    // in this case, the agent should hit the "... is a ... restaurant in the ..."
    // we treat it as "execute" dialogue act and add a filter that causes the program to return a single result

    const proposal = ctx.aux;
    const [results, /*info*/, actionProposal] = proposal;
    let good = false;
    for (let result of results) {
        if (result.value.id.equals(name)) {
            good = true;
            break;
        }
    }
    if (!good)
        return false;

    if (acceptedAction === null)
        acceptedAction = actionProposal;

    if (acceptedAction === null) {
        if (mustHaveAction)
            return null;

        const currentTable = ctx.current.stmt.table;
        const namefilter = new Ast.BooleanExpression.Atom(null, 'id', '==', name);
        const newTable = queryRefinement(currentTable, namefilter, (one, two) => new Ast.BooleanExpression.And(null, [one, two]));
        if (newTable === null)
            return null;

        return addQuery(ctx, 'execute', newTable, 'accepted');
    } else {
        if (actionProposal !== null && !C.isSameFunction(actionProposal.schema, acceptedAction.schema))
            return null;

        const chainParam = findChainParam(results[0], acceptedAction);
        if (!chainParam)
            return null;
        return addActionParam(ctx, 'execute', acceptedAction, chainParam, name, 'accepted');
    }
}

function positiveListProposalReplyActionByName(ctx, action) {
    const proposal = ctx.aux;
    const [results,] = proposal;

    let name = null;
    const acceptedAction = action.clone();
    const idType = results[0].value.id.getType();
    // find the chain parameter for the action, extract the name, and set the param to undefined
    // as the rest of the code expects
    for (let in_param of acceptedAction.in_params) {
        const arg = action.schema.getArgument(in_param.name);
        assert(arg);
        if (arg.type.equals(idType)) {
            name = in_param.value;
            in_param.value = new Ast.Value.Undefined(true);
            break;
        }
    }
    return positiveListProposalReply(ctx, [name, acceptedAction]);
}

function negativeListProposalReply(ctx, [preamble, request]) {
    const proposal = ctx.aux;
    const [results, info] = proposal;
    const proposalType = results[0].value.id.getType();
    request = combinePreambleAndRequest(preamble, request, info, proposalType);
    if (request === null)
        return null;
    return proposalReply(ctx, request, refineFilterToAnswerQuestionOrChangeFilter);
}

function listProposalLearnMoreReply(ctx, name) {
    // note: a learn more from a list proposal is different than a learn_more from a recommendation
    // in a recommendation, there is no change to the program, and the agent replies "what would
    // you like to know"
    // in a list proposal, we add a filter "id == "

    const proposal = ctx.aux;
    const [results,] = proposal;
    let good = false;
    for (let result of results) {
        if (result.value.id.equals(name)) {
            good = true;
            break;
        }
    }
    if (!good)
        return false;

    const currentTable = ctx.current.stmt.table;
    const namefilter = new Ast.BooleanExpression.Atom(null, 'id', '==', name);
    const newTable = queryRefinement(currentTable, namefilter, (one, two) => new Ast.BooleanExpression.And(null, [one, two]));
    if (newTable === null)
        return null;

    return addQuery(ctx, 'execute', newTable, 'accepted');
}

module.exports = {
    checkListProposal,
    addActionToListProposal,
    makeListProposalReply,

    positiveListProposalReply,
    positiveListProposalReplyActionByName,
    listProposalLearnMoreReply,
    negativeListProposalReply
};
