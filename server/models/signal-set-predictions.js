'use strict';

const knex = require('../lib/knex');
const dtHelpers = require('../lib/dt-helpers');
const { enforce, filterObject } = require('../lib/helpers');
const shares = require('./shares');
const { allowedKeysCreate: allowedSignalSetKeysCreate } = require('../lib/signal-set-helpers');
const { allowedKeysCreate: allowedSignalKeysCreate } = require('../lib/signal-helpers');
const namespaceHelpers = require('../lib/namespace-helpers');
const { SignalSetType, SignalSetKind } = require('../../shared/signal-sets');
const { SignalSource } = require('../../shared/signals');
const createSigSet = require('./signal-sets').createTx;
const createSignal = require('./signals').createTx;
const { PredictionTypes } = require('../../shared/predictions');
const interoperableErrors = require('../../shared/interoperable-errors');
const jobs = require('./jobs');
const removeSigSetById = require('./signal-sets').removeById;


const allowedKeys = new Set(['name', 'set', 'type', 'namespace', 'settings', 'ahead_count', 'future_count']);

const deleteCallbacks = {
    [PredictionTypes.ARIMA]: async (tx, context, predictionId) => {
        // doing arima specific cleanup before the remaining is taken care of
    }
}

async function listDTAjax(context, sigSetId, params) {
    return await dtHelpers.ajaxList(
        params,
        builder => builder
            .from('predictions')
            .where('set', sigSetId),
        //.join('predictions_signal_sets', 'set', '=', 'predictions_signal_sets.id'),
        ['predictions.id', 'predictions.set', 'predictions.name', 'predictions.type'],
    );
}

async function _deleteTypeSpecificTx(tx, context, predictionId, type) {
    if (type in deleteCallbacks) {
        return await deleteCallbacks[type](tx, context, predictionId);
    }
}

async function removeById(context, setId, predictionId) {
    let jobsToDelete;
    let setsToDelete;

    const val =  await knex.transaction(async tx => {
        const existing = await tx('predictions').where('id', predictionId).first();

        if (!existing) {
            shares.throwPermissionDenied();
        }

        await shares.enforceEntityPermissionTx(tx, context, 'prediction', existing.id, 'delete');

        // Type specific delete
        await _deleteTypeSpecificTx(tx, context, predictionId, existing.type);

        // unlink remaining jobs
        jobsToDelete = await tx('predictions_jobs').where('prediction', existing.id);
        for (let job of jobsToDelete) {
            await tx('predictions_jobs').where('prediction', existing.id).where('job', job.job).del();
        }

        const predSignals = await tx('predictions_signals').where('prediction', existing.id);
        for (let signal of predSignals) {
            await tx('predictions_signals').where('prediction', signal.prediction).where('signal', signal.signal).del();
        }

        setsToDelete = await tx('predictions_signal_sets').where('prediction', existing.id);
        for (let set of setsToDelete) {
            await tx('predictions_signal_sets').where('prediction', set.prediction).where('set', set.set).del();
            // we will delete the set itself after the transaction
        }

        await tx('predictions').where('id', existing.id).del();
    });

    // delete the signal sets
    for (let set of setsToDelete) {
        await removeSigSetById(context, set.set);
    }

    // clean up the jobs
    for (let job of jobsToDelete) {
        await jobs.remove(context, job.job);
    }

    return val;
}

function _isValidType(type) {
    for (let t in PredictionTypes) {
        if (PredictionTypes[t] === type) {
            return true;
        }
    }
    return false;
}

async function _validate(context, tx, prediction) {
    await namespaceHelpers.validateEntity(tx, prediction);
    await enforce(_isValidType(prediction.type), "Invalid prediction type.");
}

async function createPredictionTx(tx, context, prediction) {
    await shares.enforceEntityPermissionTx(tx, context, 'signalSet', prediction.set, 'createPrediction');
    await _validate(context, tx, prediction);

    const filteredEntity = filterObject(prediction, allowedKeys);
    const id = await tx('predictions').insert(filteredEntity);

    await shares.rebuildPermissionsTx(tx, {
        entityTypeId: 'prediction',
        entityId: id
    });

    return id;
}

async function createPrediction(context, prediction) {
    return await knex.transtaction(async tx => {
        return await createPredictionTx(tx, context, prediction);
    });
}

async function getById(context, id) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'prediction', id, 'view');
        const entity = await tx('predictions').where('id', id).first();
        entity.settings = JSON.parse(entity.settings);

        return entity;
    });
}

async function update(context, prediction) {
    await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'prediction', prediction.id, 'edit');

        const existing = await tx('predictions').where('id', prediction.id).first();
        if (!existing) {
            throw new interoperableErrors.NotFoundError();
        }

        const filtered = filterObject(prediction, allowedKeys);
        await tx('predictions').where('id', prediction.id).update(filtered);

        await shares.rebuildPermissionsTx(tx);
    });
}

/**
 * Return predicted signals
 * @param context the calling user's context
 * @param predictionId
 * @returns an array of signals
 */
async function _getOutputSignals(tx, context, predictionId) {
    await shares.enforceEntityPermissionTx(tx, context, 'prediction', predictionId, 'view');
    // all output sets have same signal signatures, so we get one and look into
    // its signals
    const predSet = await tx('predictions_signal_sets').where('prediction', predictionId).first();
    if (!predSet) {
        throw new interoperableErrors.NotFoundError();
    }

    const signals = await tx('signals').where('set', predSet.set);

    let outputSignals = [];
    for (let signal of signals) {
        const filtered = filterObject(signal, new Set(['cid', 'name', 'type', 'description', 'namespace']))
        outputSignals.push(filtered);
    }

    return outputSignals;
}

async function getOutputConfigTx(tx, context, predictionId) {
    await shares.enforceEntityPermissionTx(tx, context, 'prediction', predictionId, 'view');

    const outSignals = await _getOutputSignals(tx, context, predictionId);

    const predSets = await tx('predictions_signal_sets').where('prediction', predictionId);
    let futureSet = {};
    let aheadSets = {};

    let i = 1;
    for (let ps of predSets) {
        let signalSet = await tx('signal_sets').where('id', ps.set).first();
        if (signalSet.cid.endsWith('future')) {
            futureSet = signalSet.cid;
        } else {
            aheadSets[i] = signalSet.cid;
            i++;
        }
    }

    return {
        ahead_sets: aheadSets,
        future_set: futureSet,
        signals: outSignals
    };
}

async function getOutputConfig(context, predictionId) {
    return await knex.transaction(async tx => {
        return await getOutputConfigTx(tx, context, predictionId);
    });
}

async function registerPredictionModelTx(tx, context, prediction, outSignals) {
    const signalSet = await tx('signal_sets').where('id', prediction.set).first();
    enforce(signalSet, `Signal set ${prediction.set} not found`);

    const predId = await createPredictionTx(tx, context, prediction);
    prediction.id = predId;
    await createOutputSignalSets(tx, context, prediction, outSignals);

    return predId;
}

async function createOutSignalSet(tx, context, signalSet, predictionId) {
    const filteredSet = filterObject(signalSet, allowedSignalSetKeysCreate);
    filteredSet.type = SignalSetType.COMPUTED;
    filteredSet.kind = SignalSetKind.TIME_SERIES;

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

function generateSignalSet(cid, namespace) {
    return {
        cid: cid,
        name: cid,
        decription: "",
        namespace: namespace,
    };
}

async function _createOutputSignalSetWithSignals(tx, context, setCid, signals, predictionId, namespace) {
    const signalSet = generateSignalSet(setCid, namespace);
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
    const setPrefix = await getPrefix(tx, context, prediction.id);

    for (let i = 1; i <= prediction.ahead_count; i++) {
        const setCid = `${setPrefix}_${i}`;
        await _createOutputSignalSetWithSignals(tx, context, setCid, outSignals, prediction.id, prediction.namespace);
    }

    const futureSetCid = `${setPrefix}_future`;
    await _createOutputSignalSetWithSignals(tx, context, futureSetCid, outSignals, prediction.id, prediction.namespace);

    return {};
}

async function rebuildOuputOwnership(tx, context, modelId) {
    shares.enforceEntityPermissionTx(tx, context, 'prediction', modelId, 'edit');

    const jobs = await tx('predictions_jobs').where('prediction', modelId);
    const sets = await tx('predictions_signal_sets').where('prediction', modelId);

    for (let job of jobs) {
        for (let set of sets) {
            const signal_set_owner = {
                set: set.set,
                job: job.job
            };

            const alreadyExists = await tx('signal_sets_owners').where('set', set.set).where('job', job.job);
            if (alreadyExists.length < 1) {
                await tx('signal_sets_owners').insert(signal_set_owner);
            }
        }
    }
}

async function registerPredictionModelJobTx(tx, context, modelId, jobId) {
    shares.enforceEntityPermissionTx(tx, context, 'job', jobId, 'edit');
    shares.enforceEntityPermissionTx(tx, context, 'prediction', modelId, 'edit');

    const predJob = {
        prediction: modelId,
        job: jobId
    };

    await tx('predictions_jobs').insert(predJob);
    await rebuildOuputOwnership(tx, context, modelId);
}

module.exports.getById = getById;
module.exports.removeById = removeById;
module.exports.registerPredictionModelTx = registerPredictionModelTx;
module.exports.registerPredictionModelJobTx = registerPredictionModelJobTx;
module.exports.update = update;
module.exports.getOutputConfigTx = getOutputConfigTx;
module.exports.getOutputConfig = getOutputConfig;
module.exports.listDTAjax = listDTAjax;