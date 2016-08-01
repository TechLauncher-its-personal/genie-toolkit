// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2016 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const Q = require('q');

const ThingTalk = require('thingtalk');

const ThingPediaClient = require('./http_client');

class MockPreferences {
    constructor() {
        this._store = {};

        // change this line to test the initialization dialog
        this._store['sabrina-initialized'] = true;
        this._store['sabrina-name'] = "Alice Tester";
    }

    get(name) {
        return this._store[name];
    }

    set(name, value) {
        console.log('SharedPreferences.set %s %s'.format(name, JSON.stringify(value)));
        this._store[name] = value;
    }
}

class MockStatistics {
    constructor() {
        this._store = {};
    }

    snapshot() {
        console.log('Statistics snapshot');
    }

    keys() {
        return Object.keys(this._store);
    }

    set(key, value) {
        return this._store[key] = value;
    }

    get(key) {
        return this._store[key];
    }

    hit(key) {
        var old = this._store[key];
        if (old === undefined)
            old = 0;
        this._store[key] = old+1;
    }
}

class MockAppDatabase {
    constructor() {
        this._apps = {};
    }

    getApp(appId) {
        return this._apps[appId];
    }

    loadOneApp(code, state, uniqueId, tier, name, description, addToDB) {
        console.log('MOCK: App ' + name + ' with code ' + code + ' loaded');
        this._apps[uniqueId] = { code: code, state: state, uniqueId: uniqueId };
        return Q();
    }
}

class MockNineGagDevice {
    constructor() {
        this.name = "NineGag";
        this.kind = 'ninegag';
        this.uniqueId = '9gag';
    }
}

class MockTwitterDevice {
    constructor(who) {
        this.name = "Twitter Account " + who;
        this.kind = 'twitter';
        this.uniqueId = 'twitter-' + who;
    }
}

class MockBluetoothDevice {
    constructor(who, paired) {
        this.name = "Bluetooth Device " + who;
        this.description = 'This is a bluetooth device of some sort';
        this.kind = 'mock.bluetooth';
        this.uniqueId = 'mock.bluetooth-' + who;
        this.discoveredBy = 'phone';
        this.paired = paired;
    }

    completeDiscovery(delegate) {
        if (this.paired) {
            delegate.configDone();
            return Q();
        }

        console.log('MOCK: Pairing with ' + this.uniqueId);
        return delegate.confirm('Do you confirm the code 123456?').then((res) => {
            if (!res) {
                delegate.configFailed(new Error('Cancelled'));
                return;
            }

            console.log('MOCK: Pairing done');
            this.paired = true;
            delegate.configDone();
        });
    }
}

class MockBingQuery {
    constructor() {
        this.uniqueId = 'com.bing-web_search';
    }

    formatEvent(event) {
        return { type: 'rdl', displayTitle: event[0], displayText: event[1],
            webCallback: event[2], callback: event[2] };
    }

    invokeQuery() {
        return Q([
            ['Google', "Google is where you should really run your searches", 'http://google.com'],
            ['Bing', "Bing is what you're using. So dumb it's not even first!", 'http://bing.com'],
            ['Yahoo', "If all else fails", 'http://yahoo.com']
        ])
    }

    close() {
    }
}

class MockBingDevice {
    constructor() {
        this.name = "Bing Search";
        this.description = "I know you secretly want to bing your hot friend.";
        this.kind = 'com.bing';
        this.uniqueId = 'com.bing';
    }

    getQuery(id) {
        if (id !== 'web_search')
            throw new Error('Unexpected id in MOCK Bing: ' + id);
        return Q(new MockBingQuery());
    }
}

class MockPhoneDevice {
    constructor() {
        this.name = "Phone";
        this.description = "Your phone, in your hand. Not that hand, the other one.";
        this.kind = 'org.thingpedia.builtin.thingengine';
        this.own = true;
        this.tier = 'phone';
        this.globalName = 'phone';
        this.uniqueId = 'thingengine-own-phone';
    }

    invokeTrigger(trigger, callback) {
        switch (trigger) {
        case 'gps':
            return Q([{ y: 37.4275, x: -122.1697 }, 29, 0, 0]); // at stanford, on the ground, facing north, standing still
        default:
            throw new Error('Invalid trigger'); // we don't mock anything else
        }
    }
}

var _cnt = 0;

class MockUnknownDevice {
    constructor(kind) {
        var id = ++_cnt;

        this.name = "Some Device " + id;
        this.description = 'This is a device of some sort';
        this.kind = kind;
        this.uniqueId = kind + '-' + id;
    }
}

class MockDeviceDatabase {
    constructor() {
        this._devices = {};
        this._devices['9gag'] = new MockNineGagDevice();
        this._devices['twitter-foo'] = new MockTwitterDevice('foo');
        this._devices['twitter-bar'] = new MockTwitterDevice('bar');
        this._devices['thingengine-own-phone'] = new MockPhoneDevice();
    }

    loadOneDevice(blob, save) {
        if (blob.kind === 'com.bing') {
            console.log('MOCK: Loading bing');
            return Q(this._devices['com.bing'] = new MockBingDevice());
        } else {
            console.log('MOCK: Loading device ' + JSON.stringify(blob));
            return Q(new MockUnknownDevice(blob.kind));
        }
    }

    getDevice(id) {
        return this._devices[id];
    }

    getAllDevices() {
        return Object.keys(this._devices).map(function(k) { return this._devices[k]; }, this);
    }

    getAllDevicesOfKind(kind) {
        return this.getAllDevices().filter(function(d) { return d.kind === kind; });
    }
}

class MockDiscoveryClient {
    runDiscovery(timeout, type) {
        return Q([new MockBluetoothDevice('foo', true), new MockBluetoothDevice('bar', false)]);
    }

    stopDiscovery() {
        return Q();
    }
}

var thingpedia = new ThingPediaClient(null);

module.exports.createMockEngine = function() {
    return {
        platform: {
            _prefs: new MockPreferences(),

            getSharedPreferences() {
                return this._prefs;
            },

            locale: 'en_US.utf8',
            //locale: 'it',

            hasCapability(cap) {
                return cap === 'gettext';
            },

            getCapability(cap) {
                if (cap === 'gettext') {
                    var Gettext = require('node-gettext');
                    var gt = new Gettext();
                    gt.setlocale(this.locale);
                    return gt;
                } else {
                    return null;
                }
            }
        },
        stats: new MockStatistics,
        thingpedia: thingpedia,
        schemas: new ThingTalk.SchemaRetriever(thingpedia),
        devices: new MockDeviceDatabase(),
        apps: new MockAppDatabase(),
        discovery: new MockDiscoveryClient(),
    };
};
