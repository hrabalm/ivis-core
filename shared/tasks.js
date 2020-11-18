'use strict';

const TaskType = {
    PYTHON: 'python',
};

const defaultSubtypeKey = '__default__';

const PythonSubtypes = {
    ENERGY_PLUS: 'energy_plus',
    NUMPY: 'numpy',
    ARIMA: 'arima'
};

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
            libs: [...defaultPythonLibs, 'numpy', 'statsmodels', 'pmdarima']
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

const TaskSource = {
    USER: 'user',
    BUILTIN: 'builtin'
};

function getFinalStates() {
    return [BuildState.FINISHED, BuildState.FAILED, BuildState.UNINITIALIZED];
}

function getTransitionStates() {
    return [BuildState.INITIALIZING, BuildState.PROCESSING, BuildState.SCHEDULED];
}

function isTransitionState(state) {
    return getTransitionStates().includes(state);
}

module.exports = {
    TaskType,
    subtypesByType,
    PythonSubtypes,
    defaultSubtypeKey,
    BuildState,
    TaskSource,
    getFinalStates,
    getTransitionStates,
    isTransitionState
};
