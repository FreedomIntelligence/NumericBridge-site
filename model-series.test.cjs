'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
require('./search.js');
require('./cases.js');
const {modelIdentity,seriesRecommendations}=global.NumericBridgeCases;

test('series normalization keeps checkpoint generations separate and does not guess unknown models',()=>{
  assert.deepEqual(modelIdentity({model:'Qwen/Qwen3-0.6B',model_group:'Qwen3 Dense'}),{series:'Qwen3',type:'dense',traits:[]});
  assert.equal(modelIdentity({model:'Qwen/Qwen3-4B',model_group:'Qwen3 Dense'}).series,'Qwen3');
  assert.equal(modelIdentity({model:'Qwen/Qwen3.8-27B',model_group:'Qwen3.5 Dense'}).series,'Qwen3.8');
  assert.equal(modelIdentity({model:'owner/Foo-4B',model_group:'unclassified'}).series,'owner/Foo-4B');
  assert.equal(modelIdentity({model:'owner/Foo-4B',model_group:'MoE'}).series,'owner/Foo-4B');
  assert.equal(modelIdentity({model:'unknown',model_group:'A Dense',model_architecture:'A MoE'}).type,'');
});

test('architecture groups never substitute across architecture, hardware, framework, or version',()=>{
  // Synthetic records only: the published snapshot has no verified Dense/MoE pair in one series.
  function make(id,type,scope,settings={},architecture=''){
    const row={id,type,series:'Synthetic',traits:architecture?[architecture]:[],kind:'comparison',recordId:id,hardware:'CPU',libraries:[{name:'Framework',version:'1'}],tasks:['inference'],settings};
    row.searchConfig={id,frameworks:['Framework'],recommendations:scope===null?[]:[{scope}],libraries:[{keys:['framework'],version:'1'}],tasks:row.tasks,keys:{hardware:['cpu'],library:['framework']}};
    row.searchContext={aliases:{},hardware_rules:[]};
    return row;
  }
  const configurations=[make('dense','dense','verified for this workload'),make('moe','moe',null),make('loop','moe','verified in scope',{precision_intervention:'Loop-specific adaptation verified on the updated path'},'Loop'),make('hybrid','moe','Hybrid attention was part of the model, without a recorded separate adaptation',{},'Hybrid attention')];
  const index={search:{aliases:{library:{}}},cases:[{category:'precision-evaluation',configurations}],records:new Map(configurations.map(x=>['comparison:'+x.recordId,{id:x.recordId}]))};
  const filters={series:'Synthetic',hardware:'CPU',library:'Framework',task:'inference',hardwareMode:'platform'};
  const list=overrides=>Object.fromEntries(seriesRecommendations(index,{...filters,...overrides}).map(g=>[g.architecture,g.rows.map(r=>r.record.id)]));
  assert.deepEqual(list(),{'Dense':['dense'],'MoE':['hybrid'],'MoE · Loop':['loop']});
  for(const filter of [{hardware:'Other hardware'},{library:'Other framework'},{version:'2'},{task:'sft'}])assert.deepEqual(list(filter),{});
  configurations.splice(2);
  assert.deepEqual(list(),{'Dense':['dense'],'MoE':[]});
});
