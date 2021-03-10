// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2019-2020 The Board of Trustees of the Leland Stanford Junior University
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
// Author: Naoki Yamamura <yamamura@cs.stanford.edu>
"use strict";

const fs = require('fs');
const fsExtra = require('fs-extra')
const assert = require('assert');
const util = require('util');
const path = require('path');
const os = require('os');

const ThingTalk = require('thingtalk');
const Type = ThingTalk.Type;

const I18N = require('../../../lib/i18n');
const StreamObject = require('stream-json/streamers/StreamObject');

const INSTANCE_OF_PROP = "P31"

const {
    getType,
    getElementType,
    argnameFromLabel,
    loadSchemaOrgManifest
} = require('./utils');

class ParamDatasetGenerator {
    constructor(options) {
        this._locale = options.locale;
        this._domains = options.domains;
        this._canonicals = options.canonicals;
        this._input_dir = options.inputDir;
        this._output_dir = options.outputDir;
        this._maxValueLength = options.maxValueLength;
        this._tokenizer = I18N.get(options.locale).getTokenizer();
        this._schemaorgManifest = options.schemaorgManifest;
        this._schemaorgProperties = {};
        this._propery_pathes = [];
        this._properties;
        this._instances;
    }

    async _readSync(func, dir) {
        return util.promisify(func)(dir, { encoding: 'utf8' });
    }

    async _processData(canonical) {
        const domainProperties = JSON.parse(await this. _readSync(fs.readFile, this._propery_pathes[0]));
        const propertyLabels = JSON.parse(await this. _readSync(fs.readFile, path.join(this._input_dir, 'filtered_property_wikidata4.json')));
        const itemLabels = JSON.parse(await this. _readSync(fs.readFile, this._propery_pathes[3]));
        const outputDir = path.join(this._output_dir, canonical, 'parameter-datasets');
        const datasetPathes = new Set();
        const filteredDomainProperties = [];
        
        console.log('Processing properties');
        for (const [property, qids] of Object.entries(domainProperties)) {
            // Ignore list for now as later step throws error
            if (['P2439'].indexOf(property) > -1)
                continue;
            const label = propertyLabels[property];
            let type = await getType(canonical, property, label, this._schemaorgProperties);
            let fileId = `org.wikidata:${(await argnameFromLabel(label))}`;
            let isEntity = false;

            // If we cannot map to some type, treat it as string
            if (type) {
                type = getElementType(type);
                
                if (type.isEntity) {
                    const typeStr = type.toString();
                    fileId = `${typeStr.substring(typeStr.lastIndexOf("Entity(") + 7, typeStr.indexOf(")"))}`;
                    isEntity = true;
                }  else if (type.isLocation) {
                    fileId = 'tt:location';
                    isEntity = true;
                }  else if (type.isCurrency) {
                    fileId = 'tt:currency_code';
                    isEntity = true;
                } else if (type.isString) {
                    isEntity = false;
                } else { // Enum, Date, Measure, Number
                    filteredDomainProperties.push(property);
                    continue;
                }
            }

            // Set file path based on if string or entity
            const outputPath = path.join(outputDir, `${fileId}.${isEntity?'json':'tsv'}`);

            const data = [];
            for (const qid of qids) {
                // Tokenizer throws error.
                if (itemLabels[qid].includes('æ'))
                    continue;
                
                const tokens = this._tokenizer.tokenize(itemLabels[qid]).tokens;
                // if some tokens are uppercase, they are entities, like NUMBER_0,
                // in which case we ignore this value
                if (tokens.length === 0 || tokens.some((tok) => /^[A-Z]/.test(tok)))
                    continue;

                const tokenizedString = tokens.join(' ');    
                if (this._maxValueLength && 
                    this._maxValueLength >= 0 && 
                    tokenizedString.length > this._maxValueLength)
                    continue;

                if (isEntity) {
                    data.push({
                        'value': itemLabels[qid],
                        'name': qid,
                        'canonical': tokenizedString
                    });
                } else {
                    const weight = 1;
                    data.push(`${itemLabels[qid]}\t${tokenizedString}\t${weight}`);
                }
            }

            if (data.length !== 0) {
                if (!type) { // Print unmapped type.
                    console.log(`'${property}': ${type}, // ${label}, found ${data.length} values`);
                }
                
                filteredDomainProperties.push(property);
                // Dump propety data
                let dataPath;
                if (isEntity) {
                    let outData = { result: 'ok', data };
                    dataPath = `entity\t${this._locale}\t${fileId}\t${path.relative(path.join(this._output_dir, canonical), outputPath)}\n`;
                    if (datasetPathes.has(dataPath)) {
                        outData = JSON.parse(await this. _readSync(fs.readFile, outputPath));
                        // Just keep unique values
                        outData['data'] = Array.from(new Set(outData['data'].concat(data)));
                    }
                    await util.promisify(fs.writeFile)(outputPath, JSON.stringify(outData, undefined, 2), { encoding: 'utf8' });
                } else {
                    dataPath = `string\t${this._locale}\t${fileId}\t${path.relative(path.join(this._output_dir, canonical), outputPath)}\n`;
                    let outData = data.join(os.EOL).concat(os.EOL);
                    await util.promisify(fs.appendFile)(outputPath, outData, { encoding: 'utf8' });
                }
                datasetPathes.add(dataPath);
            }
        }
            await Promise.all([
                util.promisify(fs.writeFile)(this._propery_pathes[6],
                    Array.from(datasetPathes).join(''), { encoding: 'utf8' }),
                util.promisify(fs.writeFile)(this._propery_pathes[5], 
                    filteredDomainProperties.join(','), { encoding: 'utf8' })
            ]);    
        console.log(`${filteredDomainProperties.length} filtered properties in domain.`);  
    }

    async _filterItemValues(canonical) {
        if (!fs.existsSync(this._propery_pathes[0]) || !fs.existsSync(this._propery_pathes[2])) {
            throw Error('Required file(s) missing.');
        }
        const properties = JSON.parse(await this. _readSync(fs.readFile, this._propery_pathes[0]));
        const instanceQids = new Set((await this. _readSync(fs.readFile, this._propery_pathes[2])).split(','));

        let propertyQids = [];
        for (const qids of Object.values(properties)) {
            propertyQids = propertyQids.concat(qids);
        }
        propertyQids = new Set(propertyQids);
        const propertyValues = {};
        const instanceValues = {};

        console.log(`Processing items_wikidata_n.json`);
        const pipeline = fs.createReadStream(path.join(this._input_dir, `items_wikidata_n.json`)).pipe(StreamObject.withParser());
        pipeline.on('data', async data => {
            const key = String(data.key);
            const value = String(data.value);

            if (instanceQids.has(key)) {
                instanceValues[key] = value;
            }
            if (propertyQids.has(key)) {
                propertyValues[key] = value;
            }
        });

        pipeline.on('error', error => console.error(error));
        pipeline.on('end', async () => {
            console.log(`Found ${Object.keys(propertyValues).length} items in domain property.`);
            await Promise.all([
                util.promisify(fs.writeFile)(this._propery_pathes[3], 
                    JSON.stringify(propertyValues), { encoding: 'utf8' }),
                util.promisify(fs.writeFile)(this._propery_pathes[4], 
                    JSON.stringify(instanceValues), { encoding: 'utf8' })    
            ]);
            await this._processData(canonical);
        });
    }

    async _mapDomainRevProperties(canonical) {
        if (!fs.existsSync(this._propery_pathes[0]) || !fs.existsSync(this._propery_pathes[2])) {
            throw Error('Required file(s) missing.');
        }

        console.log('Processing comp_wikidata_rev.json')
        const properties = JSON.parse(await this. _readSync(fs.readFile, this._propery_pathes[0]));
        const instanceQids = new Set((await this. _readSync(fs.readFile, this._propery_pathes[2])).split(','));        
        const filteredProperties = JSON.parse(await this. _readSync(fs.readFile, path.join(this._input_dir, 'filtered_property_wikidata4.json')));
        const pipeline = fs.createReadStream(path.join(this._input_dir, `comp_wikidata_rev.json`)).pipe(StreamObject.withParser());

        pipeline.on('data', async data => {
            if (instanceQids.has(data.key)) {
                for (const [key, value] of Object.entries(data.value)) {
                    if (key in filteredProperties) {
                        if (!(key in properties)) {
                            properties[key] = [];
                        }
                        properties[key] = Array.from(new Set(properties[key].concat(value)));
                    }
                }
            }
        });

        pipeline.on('error', error => console.error(error));
        pipeline.on('end', async () => {
            console.log(`Found ${instanceQids.size} instances in ${canonical} domain with ${Object.keys(properties).length} properties.`);
            await Promise.all([
                util.promisify(fs.writeFile)(this._propery_pathes[0], 
                    JSON.stringify(properties), { encoding: 'utf8' }),
                util.promisify(fs.writeFile)(this._propery_pathes[1], 
                    Object.keys(properties).join(','), { encoding: 'utf8' })
            ]);
            await this._filterItemValues(canonical);
        });
    }

    async _mapDomainProperties(domain, canonical, idx, mapReverse) {
        console.log(`Processing wikidata_short_${idx + 1}.json`);
        const filteredProperties = JSON.parse(await this. _readSync(fs.readFile, path.join(this._input_dir, 'filtered_property_wikidata4.json')));
        const pipeline = fs.createReadStream(path.join(this._input_dir, `wikidata_short_${idx + 1}.json`)).pipe(StreamObject.withParser());
        
        pipeline.on('data', async data => {
            if (INSTANCE_OF_PROP in data.value) {
                const entry = new Set(data.value[INSTANCE_OF_PROP]);
                if (entry.has(domain)) {
                    for (const [key, value] of Object.entries(data.value)) {
                        if (key in filteredProperties) {
                            if (!(key in this._properties)) {
                                this._properties[key] = [];
                            }
                            this._properties[key] = Array.from(new Set(this._properties[key].concat(value)));
                        }
                    }
                    this._instances.add(String(data.key));
                }
            }
        });

        pipeline.on('error', error => console.error(error));
        pipeline.on('end', async () => {
            // Stream another wikidata file if there is any left
            if (idx !== 0) {
               await this._mapDomainProperties(domain, canonical, idx - 1, mapReverse);
            } else {
                console.log(`Found ${this._instances.size} instances in ${canonical} domain with ${Object.keys(this._properties).length} properties.`);
                await Promise.all([
                    util.promisify(fs.writeFile)(this._propery_pathes[0], 
                        JSON.stringify(this._properties), { encoding: 'utf8' }),
                    util.promisify(fs.writeFile)(this._propery_pathes[2], 
                        Array.from(this._instances).join(','), { encoding: 'utf8' })    
                ]);
                
                if (mapReverse) { // Map reverse relations as well.
                    await this._mapDomainRevProperties(canonical);
                } else {
                    await this._filterItemValues(canonical);
                }
            }
        });
    }

    async run() {
        // Required CSQA Wikidata json files
        assert(fs.existsSync(path.join(this._input_dir, 'filtered_property_wikidata4.json')));
        assert(fs.existsSync(path.join(this._input_dir, `items_wikidata_n.json`)));
        assert(fs.existsSync(path.join(this._input_dir, `wikidata_short_1.json`)));
        assert(fs.existsSync(path.join(this._input_dir, `wikidata_short_2.json`)));
        assert(fs.existsSync(path.join(this._input_dir, `comp_wikidata_rev.json`)));

        await loadSchemaOrgManifest(this._schemaorgManifest, this._schemaorgProperties);
        for (const idx in this._domains) {
            this._propery_pathes = [
                path.join(this._output_dir, this._canonicals[idx], 'property_item_map.json'),
                path.join(this._output_dir, this._canonicals[idx], 'properties_all.txt'),
                path.join(this._output_dir, this._canonicals[idx], 'instances.txt'),
                path.join(this._output_dir, this._canonicals[idx], 'property_item_values.json'),
                path.join(this._output_dir, this._canonicals[idx], 'instance_item_values.json'),
                path.join(this._output_dir, this._canonicals[idx], 'properties.txt'),
                path.join(this._output_dir, this._canonicals[idx], 'parameter-datasets.tsv')
            ];
            // Set up
            const outputDir = path.join(this._output_dir, this._canonicals[idx], 'parameter-datasets');
            await util.promisify(fsExtra.emptyDir)(outputDir); // Clean up parameter-datasets
            await util.promisify(fs.mkdir)(outputDir, { recursive: true });

            // Process domain property map for the first time then process data.
            if (!fs.existsSync(this._propery_pathes[0]) || 
                !fs.existsSync(this._propery_pathes[1]) || 
                !fs.existsSync(this._propery_pathes[2]) ||
                !fs.existsSync(this._propery_pathes[3]) ||
                !fs.existsSync(this._propery_pathes[4])) {
                this._properties = {};
                this._instances = new Set();    
                await this._mapDomainProperties(this._domains[idx], this._canonicals[idx], 1, true);
            } else {
                await this._processData(this._canonicals[idx]);
            }
        }
    }
}

module.exports = {
    initArgparse(subparsers) {
        const parser = subparsers.add_parser('wikidata-preprocess-data', {
            add_help: true,
            description: "Generate parameter-datasets.tsv from processed wikidata dump. "
        });
        parser.add_argument('-o', '--output', {
            required: true,
            help: ''
        });
        parser.add_argument('-i', '--input', {
            required: true,
            help: ''
        });
        parser.add_argument('--locale', {
            required: false,
            default: 'en-US'
        });
        parser.add_argument('--domains', {
            required: true,
            help: 'domains (by item id) to process data, split by comma (no space)'
        });
        parser.add_argument('--domain-canonicals', {
            required: true,
            help: 'the canonical form for the given domains, used as the query names, split by comma (no space);'
        });
        parser.add_argument('--schemaorg-manifest', {
            required: false,
            help: 'Path to manifest.tt for schema.org; used for predict the type of wikidata properties'
        });
        parser.add_argument('--max-value-length', {
            required: false,
            help: ''
        });
    },

    async execute(args) {
        const domains = args.domains.split(',');
        const canonicals = args.domain_canonicals.split(',');
        const paramDatasetGenerator = new ParamDatasetGenerator({
            locale: args.locale,
            domains: domains,
            canonicals: canonicals,
            inputDir: args.input,
            outputDir: args.output,
            schemaorgManifest:args.schemaorg_manifest,
            maxValueLength: args.max_value_length
        });
        paramDatasetGenerator.run();
    }
};