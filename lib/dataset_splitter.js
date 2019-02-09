// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2018-2019 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const Stream = require('stream');

const { coin } = require('./random');
const { requoteSentence, requoteProgram, getFunctions } = require('./requoting');

function filterForDevices(set, code) {
    for (let token of code.split(' ')) {
        if (token.startsWith('@')) {
            let split = token.substring(1).split('.');
            let kind = split.slice(0, split.length-1).join('.');
            if (!set.has(kind))
                return false;
        }
    }
    return true;
}

function join(iterable) {
    return Array.from(iterable).join(' ');
}

const SPLIT_STRATEGIES = {
    id: () => undefined,
    'raw-sentence': (id, sentence) => sentence,
    sentence: (id, sentence, program) => join(requoteSentence(id, sentence, program)),
    program: (id, sentence, program) => join(requoteProgram(program)),
    combination: (id, sentence, program) => join(getFunctions(program))
};

module.exports = class DatasetSplitter extends Stream.Writable {
    constructor(options) {
        super({ objectMode: true });

        this._rng = options.rng;
        this._locale = options.locale;

        this._train = options.train;
        this._eval = options.eval;
        this._test = options.test;

        this._evalProbability = options.evalProbability;
        this._forDevices = new Set(options.forDevices || []);

        this._splitStrategy = SPLIT_STRATEGIES[options.splitStrategy || 'sentence'];

        this._devtestset = new Set;
        this._trainset = new Set;
    }

    _write(row, encoding, callback) {
        if (this._forDevices.size > 0 && !filterForDevices(this._forDevices, row.target_code))
            return;

        const splitKey = this._splitStrategy(row.id, row.preprocessed, row.target_code);
        const flags = row.flags || {};

        //console.log(flags, splitKey, this._devtestset);

        if (flags.synthetic || flags.augmented) {
            if (splitKey !== undefined && this._devtestset.has(splitKey)) {
                callback();
                return;
            }
            this._train.write(row, callback);
        } else {
            if (splitKey !== undefined && this._devtestset.has(splitKey)) {
                if (this._test && coin(0.5, this._rng))
                    this._test.write(row, callback);
                else
                    this._eval.write(row, callback);
            } else if (splitKey !== undefined && this._trainset.has(splitKey)) {
                this._train.write(row, callback);
            } else if (coin(this._evalProbability, this._rng)) {
                if (this._test && coin(0.5, this._rng))
                    this._test.write(row, callback);
                else
                    this._eval.write(row, callback);
                if (splitKey !== undefined)
                    this._devtestset.add(splitKey);
            } else {
                this._train.write(row, callback);
                if (splitKey !== undefined)
                    this._trainset.add(splitKey);
            }
        }
    }
};