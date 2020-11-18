'use strict';

const knex = require('../lib/knex');
const {getVirtualNamespaceId} = require("../../shared/namespaces");
const {TaskSource, BuildState, TaskType} = require("../../shared/tasks");
const em = require('../lib/extension-manager');
const arima = require('./arima/arima.js');

const aggregationTask = {
    name: 'aggregation',
    description: 'Task used by aggregation feature for signal sets',
    type: TaskType.PYTHON,
    settings: {
        params: [{
            "id": "signalSet",
            "type": "signalSet",
            "label": "Signal Set",
            "help": "Signal set to aggregate",
            "includeSignals": true
        }, {
            "id": "ts",
            "type": "signal",
            "signalSetRef": "signalSet",
            "label": "Timestamp signal",
            "help": "Timestamp for aggregation"
        },{
            "id": "offset",
            "type": "string",
            "label": "Offset",
            "help": "Since when should aggregation be done"
        }, {
            "id": "interval",
            "type": "string",
            "label": "Interval",
            "help": "Bucket interval"
        }],
        code: `from ivis import ivis

es = ivis.elasticsearch
state = ivis.state
params= ivis.parameters
entities= ivis.entities
#owned= ivis.owned

sig_set_cid = params['signalSet']
sig_set = entities['signalSets'][sig_set_cid]
ts = entities['signals'][sig_set_cid][params['ts']]
interval = params['interval']
offset = params['offset']

agg_set_cid =  f"aggregation_{interval}_{sig_set_cid}"

numeric_signals = { cid: signal for (cid,signal) in entities['signals'][sig_set_cid].items() if (signal['type'] in ['integer','long','float','double']) }

if state is None or state.get(agg_set_cid) is None:
  ns = sig_set['namespace']
    
  signals= []
  for cid, signal in numeric_signals.items():
    signal_base = {
      "cid": signal['cid'],
      "name": signal['name'],
      "description": signal['description'],
      "namespace": signal['namespace'],
      "type": signal['type'],
      "indexed": signal['indexed'],
      "settings": signal['settings']
    }
    signals.append(signal_base)
  
  # Cid is important it is used in the system to identify related signals
    for stat in ['min', 'max', 'count', 'sum']:
      signal = signal_base.copy()
      signal.update({
        "cid": f"_{signal_base['cid']}_{stat}",
        "name": f"{stat} of {signal_base['cid']}",
        "description": f"Stat {stat} for aggregation of signal '{signal_base['cid']}'"
      })
      signals.append(signal)

  signals.append({
      "cid": ts['cid'],
      "name": ts['name'],
      "description": ts['description'],
      "namespace": ts['namespace'],
      "type": ts['type'],
      "indexed": ts['indexed'],
      "settings": ts['settings']
  })

  state = ivis.create_signal_set(
    agg_set_cid,
    ns,
    agg_set_cid,
    f"aggregation with interval '{interval}' for signal set '{sig_set_cid}'",
    None,
    signals)
    
  state['last'] = None
  ivis.store_state(state)
  
if state is not None and state.get('last') is not None:
  last = state['last']
  filter = {
    "range": {
      ts['field']: {
        "gte" : last
      }
    }
  }

  es.delete_by_query(index=state[agg_set_cid]['index'], body={
    "query": { 
      "match": {
        state[agg_set_cid]['fields']['ts']: last
      }
    }
  })
  
else:
  if offset is not None:
    filter = {
      "range": {
        ts['field']: {
          "gte": offset,
          "format":  "yyyy-MM-dd HH:mm:ss"
        }
      }
    } 
  else:
    filter = {'match_all': {}}

query_content = {
  "bool": {
    "filter": filter
  }
}

stat_aggs = {}
for cid, signal in numeric_signals.items():
  stat_aggs[cid] = {
    "stats": {
      "field": signal['field']
    }
  }
 
# interval is deprecated in the newer elasticsearch, instead fixed_interval should be used
query = {
  'size': 0,
  'query': query_content,
  "aggs": {
    "sig_set_aggs": {
      "date_histogram": {
        "field": ts['field'],
        "interval": interval
      },
      "aggs": stat_aggs
    }
  }
}

res = es.search(index=sig_set['index'], body=query)

for hit in res['aggregations']['sig_set_aggs']['buckets']:
  last = hit['key_as_string']
  doc = {}
  for cid in numeric_signals.keys():
    doc[state[agg_set_cid]['fields'][f"_{cid}_min"]]= hit[cid]['min']
    doc[state[agg_set_cid]['fields'][cid]]= hit[cid]['avg']
    doc[state[agg_set_cid]['fields'][f"_{cid}_max"]]= hit[cid]['max']
    doc[state[agg_set_cid]['fields'][f"_{cid}_count"]]= hit[cid]['count']
    doc[state[agg_set_cid]['fields'][f"_{cid}_sum"]]= hit[cid]['sum']
  
  doc[state[agg_set_cid]['fields'][ts['cid']]] = last
  res = es.index(index=state[agg_set_cid]['index'], id=last, doc_type='_doc', body=doc)


state['last'] = last
ivis.store_state(state)`
    },
};

const arimaTask = arima.arimaTask;

/**
 * All default builtin tasks
 */
const builtinTasks = [
    aggregationTask,
    arimaTask
];

em.on('builtinTasks.add', addTasks);

async function getBuiltinTask(name) {
    return await knex.transaction(async tx => {
        return await checkExistence(tx, name)
    });
}

/**
 * Check if builtin in task with fiven name alredy exists
 * @param tx
 * @param name
 * @return {Promise<any>} undefined if not found, found task otherwise
 */
async function checkExistence(tx, name) {
    return await tx('tasks').where({
        source: TaskSource.BUILTIN,
        name: name
    }).first();
}

/**
 * Store given task as a builtin task to system
 * @param tx
 * @param builtinTask task to add
 * @return {Promise<void>}
 */
async function addBuiltinTask(tx, builtinTask) {
    const task = {...builtinTask};
    task.source = TaskSource.BUILTIN;
    task.namespace = getVirtualNamespaceId();
    task.settings = JSON.stringify(task.settings);
    task.build_state = BuildState.UNINITIALIZED;
    await tx('tasks').insert(task);
}

/**
 * Update existing task
 * @param tx
 * @param id of existing task
 * @param builtinTask columns being updated
 * @return {Promise<void>}
 */
async function updateBuiltinTask(tx, id, builtinTask) {
    const task = {...builtinTask};
    task.source = TaskSource.BUILTIN;
    task.namespace = getVirtualNamespaceId();
    task.settings = JSON.stringify(task.settings);
    await tx('tasks').where('id', id).update({...task, build_state: BuildState.UNINITIALIZED});
}

/**
 * Check if all default builtin tasks are in the system / set them to default state
 * @return {Promise<void>}
 */
async function storeBuiltinTasks() {
    await addTasks(builtinTasks);
}

/**
 * Add given tasks as builtin tasks
 * @param tasks
 * @return {Promise<void>}
 */
async function addTasks(tasks) {
    if (!Array.isArray(tasks)) {
        tasks = [tasks];
    }

    for (const task of tasks) {
        await knex.transaction(async tx => {
            const exists = await checkExistence(tx, task.name);
            if (!exists) {
                await addBuiltinTask(tx, task);
            } else {
                await updateBuiltinTask(tx, exists.id, task);
            }
        });
    }
}

/**
 * List all builtin tasks currently in the system
 * @return {Promise<any>}
 */
async function list() {
    const tasks = await knex('tasks').where({source: TaskSource.BUILTIN});
    tasks.forEach(task => task.settings = JSON.parse(task.settings));
    return tasks;
}

module.exports.list = list;
module.exports.storeBuiltinTasks = storeBuiltinTasks;
module.exports.getBuiltinTask = getBuiltinTask;
