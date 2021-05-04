'use strict';

const knex = require('../lib/knex');
const dtHelpers = require('../lib/dt-helpers');
const { JobState } = require("../../shared/jobs");
const { getBuiltinTask } = require("./builtin-tasks");
const jobs = require('./jobs');
const log = require('../lib/log');
//const { createTx } = require('./signals');
const { enforce, filterObject } = require('../lib/helpers');
const shares = require('./shares');

const { getSignalSetEntitySpec, allowedKeysCreate: allowedSignalSetKeysCreate } = require('../lib/signal-set-helpers')
const { getSignalEntitySpec, allowedKeysCreate: allowedSignalKeysCreate } = require('../lib/signal-helpers')
const namespaceHelpers = require('../lib/namespace-helpers');
const { SignalSetType, SignalSetKind } = require('../../shared/signal-sets');
const { SignalSource } = require('../../shared/signals');
const createSigSet = require('./signal-sets').createTx;
const getSigSet = require('./signal-sets').getById;
const createSignal = require('./signals').createTx;
const { PredictionTypes } = require('../../shared/predictions');


const allowedKeys = new Set(['name', 'set', 'type', 'state', 'namespace', 'settings', 'ahead_count', 'future_count']);

async function listDTAjax(context, sigSetId, params) {
    return await dtHelpers.ajaxList(
        params,
        builder => builder
            .from('predictions')
        .where('set', sigSetId),
        //.join('predictions_signal_sets', 'set', '=', 'predictions_signal_sets.id'),
        ['predictions.id', 'predictions.set', 'predictions.name', 'predictions.type'],
    )
}

async function _validate(context, tx, prediction) {
    await namespaceHelpers.validateEntity(tx, prediction);
}

async function createPredictionTx(tx, context, prediction) {
    console.log(`creating prediction ${JSON.stringify(prediction)}`);
    await shares.enforceEntityPermissionTx(tx, context, 'signalSet', prediction.set, 'createPrediction');
    await _validate(context, tx, prediction);

    // TODO: check prediction type exists
    const filteredEntity = filterObject(prediction, allowedKeys);
    const id = await tx('predictions').insert(filteredEntity);

    await shares.rebuildPermissionsTx(tx, {
        entityTypeId: 'prediction',
        entityId: id
    });

    console.log("Exiting...");

    return id;
}

async function createPrediction(context, prediction) {
    return await knex.transtaction(async tx => {
        return await createPredictionTx(tx, context, prediction);
    })
}

async function getParamsById(context, id) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'prediction', id, 'view');
        const model = await tx('predictions').select(['params']).where('id', id).first();
        return JSON.parse(model.params);
    });
}

async function updateParamsById(context, id, params) {
    await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'prediction', id, 'edit');
        await tx('predictions').where('id', id).update('params', JSON.stringify(params));
    });
}

async function getById(context, id) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'prediction', id, 'view');
        const entity = await tx('predictions').where('id', id).first();
        entity.params = JSON.parse(entity.params);
        // TODO: permissions also?
        return entity;
    });
}

async function getOutputConfigTx(tx, context, predictionId) {
    await shares.enforceEntityPermissionTx(tx, context, 'prediction', predictionId, 'view');
    const predSigs = await tx('predictions_signals').where('prediction', predictionId);
    const outSignals = [];
    for (let ps of predSigs) {
        // trouble with permissions, even though we have created the object
        //let signal = await getSignalByIdTx(context, ps.signal);
        let signal = await tx('signals').where('id', ps.signal);
        outSignals.push(signal);
    }

    const predSets = await tx('predictions_signal_sets').where('prediction', predictionId);
    let futureSet = {};
    //const aheadSets = [];
    let aheadSets = {};


    let i = 1;
    for (let ps of predSets) {
        //let signalSet = await getSigSet(context, ps.set);
        let signalSet = await tx('signal_sets').where('id', ps.set).first();
        if (signalSet.cid.endsWith('future')) {
            futureSet = signalSet.cid;
        } else {
            // aheadSets.push({ i: signalSet.cid });
            aheadSets[i] = signalSet.cid;
            i++; // TODO: remove
        }
    }

    let val = {
        ahead_sets: aheadSets,
        future_set: futureSet,
        signals: outSignals
    }

    return val;
}

async function getOutputConfig(context, predictionId) {
    return await knex.transaction(async tx => {
        return await getOutputConfigTx(tx, context, predictionId);
    })
}

async function registerPredictionModelTx(tx, context, prediction, outSignals) {
    const signalSet = await tx('signal_sets').where('id', prediction.set).first();
    enforce(signalSet, `Signal set ${prediction.set} not found`);

    const predId = await createPredictionTx(tx, context, prediction);
    prediction.id = predId;
    const output_config = await createOutputSignalSets(tx, context, prediction, outSignals);

    console.log(`output_config: ${JSON.stringify(output_config)}`);

    return predId;
}

async function createOutSignalSet(tx, context, signalSet, predictionId) {
    const filteredSet = filterObject(signalSet, allowedSignalSetKeysCreate);
    filteredSet.type = SignalSetType.COMPUTED;
    filteredSet.kind = SignalSetKind.TIME_SERIES;
    console.log(`filtered signal set: ${filteredSet}`);
    const setId = await createSigSet(tx, context, filteredSet);
    await tx('predictions_signal_sets').insert({
        prediction: predictionId,
        set: setId
    });
    // timestamp signal created by signal set create API
    const tsSignal = await tx('signals').where('set', setId).where('cid', 'ts').first();
    await tx('predictions_signals').insert({
        prediction: predictionId,
        signal: tsSignal.id
    });

    return setId;
}

async function createOutSignal(tx, context, signal, predictionId) {
    let filteredSignal = filterObject(signal, allowedSignalKeysCreate);
    filteredSignal.source = SignalSource.JOB;
    const sigId = await createSignal(tx, context, filteredSignal.set, filteredSignal);
    await tx('predictions_signals').insert({
        prediction: predictionId,
        signal: sigId
    });
    return sigId;
}

function generateSignalSet(cid) {
    return {
        cid: cid,
        name: cid,
        decription: "",
        namespace: 1,
    };
}

async function _createOutputSignalSetWithSignals(tx, context, setCid, signals, predictionId) {
    const signalSet = generateSignalSet(setCid);
    const setId = await createOutSignalSet(tx, context, signalSet, predictionId);

    for (let signal of signals) {
        signal.set = setId;
        await createOutSignal(tx, context, signal, predictionId);
    }
}

function _stripNonPrintable(string) {
    // strip characters other than:
    //     A-Za-z letters
    //     0-9    numbers
    //     _.-
    let regexp = /[^0-9A-Za-z_.-]+/g;
    return string.replace(regexp, '');
}

async function getPrefix(tx, context, modelId) {
    // enforce
    const prediction = await tx('predictions').where('id', modelId).first();
    const sourceSet = await tx('signal_sets').where('id', prediction.set).first();

    const cid = _stripNonPrintable(prediction.name);
    const setPrefix = `${sourceSet.cid}_${prediction.type}_${prediction.id}_${cid}`;

    return setPrefix;
}

async function createOutputSignalSets(tx, context, prediction, outSignals) {
    //const sourceSet = await tx('signal_sets').where('id', prediction.set).first();
    //const sourceSetCid = sourceSet.cid;
    //const modelType = prediction.type;
    //const id = prediction.id;
    //const cid = _stripNonPrintable(prediction.name);
    //const setPrefix = `${sourceSetCid}_${modelType}_${id}_${cid}`;

    const setPrefix = await getPrefix(tx, context, prediction.id);

    for (let i = 1; i <= prediction.ahead_count; i++) {
        const setCid = `${setPrefix}_${i}`;
        await _createOutputSignalSetWithSignals(tx, context, setCid, outSignals, prediction.id);
    }

    const futureSetCid = `${setPrefix}_future`;
    await _createOutputSignalSetWithSignals(tx, context, futureSetCid, outSignals, prediction.id);

    return {};
}

async function rebuildOuputOwnership(tx, context, modelId) {
    const jobs = await tx('predictions_jobs').where('prediction', modelId);
    const sets = await tx('predictions_signal_sets').where('prediction', modelId);

    console.log(`jobs: ${JSON.stringify(jobs)}`);
    console.log(`sets: ${JSON.stringify(sets)}`);

    for (let job of jobs) {
        for (let set of sets) {
            const signal_set_owner = {
                set: set.set,
                job: job.job
            }
            const alreadyExists = await tx('signal_sets_owners').where('set', set.set).where('job', job.job);
            console.log(`alreadyExists: "${JSON.stringify(alreadyExists)}"`);
            if (alreadyExists.length < 1) {
                await tx('signal_sets_owners').insert(signal_set_owner);
            } else {
                console.log("Record already exists!");
            }
        }
    }
}

async function registerPredictionModelJobTx(tx, context, modelId, jobId) {
    // TODO: enforce exists
    // TODO: enforce permissions
    const predJob = {
        prediction: modelId,
        job: jobId
    };
    const r = await tx('predictions_jobs').insert(predJob);
    await rebuildOuputOwnership(tx, context, modelId);
}

module.exports.getById = getById;
module.exports.registerPredictionModelTx = registerPredictionModelTx;
module.exports.registerPredictionModelJobTx = registerPredictionModelJobTx;
module.exports.getOutputConfigTx = getOutputConfigTx;
module.exports.getOutputConfig = getOutputConfig;
module.exports.listDTAjax = listDTAjax;