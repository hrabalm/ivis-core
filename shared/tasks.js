'use strict';

const TaskType = {
    PYTHON: 'python',
};

if (Object.freeze) {
    Object.freeze(TaskType)
}

const PythonSubtypes = {
    ENERGY_PLUS: 'energy_plus',
    NUMPY: 'numpy',
    ARIMA: 'arima'
};

if (Object.freeze) {
    Object.freeze(PythonSubtypes)
}

const subtypesByType = {
    [TaskType.PYTHON]: PythonSubtypes
};

const defaultPythonLibs = ['elasticsearch'];

const taskSubtypeSpecs = {
    [TaskType.PYTHON]: {
        libs: defaultPythonLibs,
        [PythonSubtypes.ENERGY_PLUS]: {
            label: 'EnergyPlus task',
            libs: [...defaultPythonLibs, 'eppy', 'requests']
        },
        [PythonSubtypes.NUMPY]: {
            label: 'Numpy task',
            libs: [...defaultPythonLibs, 'numpy', 'dtw']
        },
        [PythonSubtypes.ARIMA]: {
            label: 'ARIMA task',
            libs: [...defaultPythonLibs, 'numpy', 'statsmodels']
        }
    }
};

const BuildState = {
    SCHEDULED: 0,
    PROCESSING: 1,
    FINISHED: 2,
    FAILED: 3,
    UNINITIALIZED: 4,
    INITIALIZING: 5
};

if (Object.freeze) {
    Object.freeze(BuildState)
}

const TaskSource = {
    USER: 'user',
    BUILTIN: 'builtin'
};

if (Object.freeze) {
    Object.freeze(BuildState)
}

function getFinalStates() {
    return [BuildState.FINISHED, BuildState.FAILED, BuildState.UNINITIALIZED];
}

function getTransitionStates() {
    return [BuildState.INITIALIZING, BuildState.PROCESSING, BuildState.SCHEDULED];
}

function isTransitionState(state) {
    return getTransitionStates().includes(state);
}

function getSpecsForType(type, subtype = null) {
    const spec = taskSubtypeSpecs[type];

    if (!spec) {
        return null;
    }

    if (subtype) {
        return spec[subtype] ? spec[subtype] : null;
    }

    return spec;
}

module.exports = {
    TaskType,
    subtypesByType,
    taskSubtypeSpecs,
    BuildState,
    TaskSource,
    getFinalStates,
    getTransitionStates,
    isTransitionState
};
