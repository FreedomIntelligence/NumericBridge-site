'use strict';
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const test=require('node:test');
const {search}=require('./search.js');
const {buildIndex,filterCases,recommendConfiguration,seriesRecommendations,mountReport}=require('./cases.js');

const filters={hardware:'CPU',model:'Synthetic-1B',library:'Framework',task:'inference'};
const reportOnly='report-only';
const version='3.0.0';

function evaluation(id,frameworkVersion,eligible,passed=true){
  return {
    id,title:id,summary:'Synthetic comparison',date:'2026-11-12',task:filters.task,
    model:{name:filters.model},status:'completed',acceptance:passed?'passed':'failed',
    ...(eligible===undefined?{}:{recommendation_eligible:eligible}),
    sides:['left','right'].map(id=>({id,label:id,hardware:filters.hardware,libraries:[{name:filters.library,version:frameworkVersion}]})),
    comparisons:[{title:'Synthetic metric',side_ids:['left','right'],metrics:[{id:'error',value:0,unit:'1'}],
      coverage:[{label:'Runs',observed:2,expected:2}]}]
  };
}

function catalog(rows,{projectFlag=false}={}){
  const entities=rows.map(({id})=>({id:'case-'+id,kind:'case',scope:'Synthetic scope',
    details:{category:'precision-evaluation',title:id+' case',request:{task:filters.task}}}));
  const relations={entities,links:rows.map(({id},i)=>({relation:'includes',from:{kind:'case',id:entities[i].id},to:{kind:'comparison',id}}))};
  const evaluations={evaluations:rows};
  const repairs={repairs:[]};
  const metadata={kind:'numericbridge-search-index',schema_version:1,policy_version:2,observation_date:'2026-11-12',
    sources:[],aliases:{library:{}},hardware_rules:[],cases:entities.map((entity,i)=>{
      const row=rows[i];
      return {id:entity.id,title:entity.details.title,category:entity.details.category,scope:entity.scope,search_text:entity.details.title,
        source:{},evidence:[],issues:[],solutions:[],configurations:row.sides.map(side=>({
          id:['comparison',row.id,side.id].join(':'),record:{id:row.id,kind:'comparison',
            ...(projectFlag&&Object.hasOwn(row,'recommendation_eligible')?{recommendation_eligible:row.recommendation_eligible}:{})},
          date:row.date,model:row.model.name,model_group:'Synthetic Dense',model_series:'Synthetic',
          platforms:[side.hardware],frameworks:[filters.library],tasks:[row.task],libraries:side.libraries.map(lib=>({...lib,keys:['framework']})),
          keys:{hardware:['cpu'],model:['synthetic-1b'],model_identity:['synthetic-1b'],library:['framework']},
          recommendations:row.acceptance==='passed'?[{basis:'recorded-numerical-acceptance',scope:row.summary}]:[],
          recommendation_gaps:row.acceptance==='passed'?[]:['no-recorded-numerical-acceptance']
        }))};
    })};
  return {relations,evaluations,repairs,metadata};
}

const flagged=evaluation(reportOnly,version,false);
const legacy=evaluation('legacy','1.0.0');
const optedIn=evaluation('opted-in','2.0.0',true);
const failed=evaluation('failed','4.0.0',true,false);

function assertSearchVeto(index){
  // The flagged report is an exact, keyword-searchable match with both sides.
  const result=search(index,{...filters,version,query:reportOnly},{allow_alternatives:true});
  assert.equal(result.status,'matched');
  assert.equal(result.total,1);
  assert.equal(result.matches[0].id,'case-report-only');
  assert.deepEqual(result.matches[0].configurations.map(config=>config.record.id),[reportOnly,reportOnly]);
  assert.equal(result.recommendation,null);
  assert.deepEqual(result.recommendations,[]);
  assert.deepEqual(result.alternatives,[]);

  const related=search(index,{...filters,version:'9.0.0',query:reportOnly},{allow_alternatives:true,related_limit:3});
  assert.equal(related.related[0].id,'case-report-only');
  assert.deepEqual(related.alternatives,[]);
  assert.equal(related.recommendation,null);
}

test('compiled record veto suppresses stale recommendations without dropping search matches',()=>{
  const {metadata}=catalog([flagged],{projectFlag:true});
  assert.ok(metadata.cases[0].configurations.every(config=>config.recommendations.length),'simulate an inconsistent compiled index');
  assertSearchVeto(metadata);
});

test('raw record veto applies to exact, alternative and series recommendations; eligible and legacy cases still qualify normally',()=>{
  const {relations,evaluations,repairs,metadata}=catalog([flagged,legacy,optedIn,failed]);
  const index=buildIndex(relations,evaluations,repairs,metadata);
  assert.ok(metadata.cases[0].configurations.every(config=>config.recommendations.length),'do not mutate the input metadata');
  assertSearchVeto(index.search);
  assert.equal(recommendConfiguration(index,{...filters,version}),null);
  assert.deepEqual(filterCases(index,{...filters,version,q:reportOnly}).map(c=>c.observations[0].record.id),[reportOnly]);
  assert.deepEqual(new Set(search(index.search,{...filters,version},{allow_alternatives:true}).alternatives
    .map(option=>option.configuration.record.id)),new Set(['legacy','opted-in']));
  assert.equal(recommendConfiguration(index,{...filters,version,allowAlternatives:true}).record.id,'legacy');
  for(const record of [legacy,optedIn]){
    const tested=record.sides[0].libraries[0].version;
    assert.equal(recommendConfiguration(index,{...filters,version:tested}).record.id,record.id);
  }
  assert.equal(recommendConfiguration(index,{...filters,version:'4.0.0'}),null);
  const series={...filters,model:'',series:'Synthetic'};
  assert.deepEqual(new Set(seriesRecommendations(index,series).flatMap(group=>group.rows.map(row=>row.record.id))),new Set(['legacy','opted-in']));
  assert.deepEqual(seriesRecommendations(index,{...series,version}),[]);
});

test('legacy recommendation fallback honors the veto and preserves old acceptance requirements',()=>{
  for(const [record,expected] of [[flagged,null],[legacy,'legacy'],[optedIn,'opted-in'],[failed,null]]){
    const {relations,evaluations,repairs}=catalog([record]);
    const index=buildIndex(relations,evaluations,repairs);
    assert.deepEqual(filterCases(index,filters).map(c=>c.observations[0].record.id),[record.id]);
    assert.equal(recommendConfiguration(index,filters)?.record.id??null,expected);
  }
});

test('report details retain measured results and identify explicit report-only records in both languages',async t=>{
  const {relations,evaluations,repairs,metadata}=catalog([flagged,legacy,optedIn]);
  const entries={relations,evaluations,repairs,content:{},frameworks:{}};
  metadata.sources=Object.entries(entries).map(([name,doc])=>({file:'data/'+name+'.json',
    sha256:createHash('sha256').update(JSON.stringify(doc)).digest('hex')}));
  entries['search-index']=metadata;
  global.NumericBridgeCatalog={load:async path=>{
    const document=entries[path.slice('./data/'.length,-'.json'.length)];
    return {document,text:JSON.stringify(document)};
  }};
  t.after(()=>{delete global.NumericBridgeCatalog;});
  async function report(id,lang){
    const root={querySelector:()=>({})};
    await mountReport(root,{arg:'case-'+id,q:new URLSearchParams({comparison:id})},{lang});
    return root.innerHTML;
  }
  for(const [lang,label] of [['en','Evaluation report · Not a recommendation'],['zh','评测报告 · 不作为推荐']]){
    const html=await report(reportOnly,lang);
    assert.ok(html.includes('<p class="eyebrow">'+label+'</p>'));
    assert.ok(html.includes('<h3>Synthetic metric</h3>'));
    assert.ok(html.includes('<th scope="row">error</th><td>0</td>'));
  }
  for(const record of [legacy,optedIn])assert.ok((await report(record.id,'en')).includes('<p class="eyebrow">Evaluation details</p>'));
});
