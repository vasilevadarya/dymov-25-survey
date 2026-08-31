function scalar(v){ if(v&&typeof v==='object'&&v.skipped)return ''; if(Array.isArray(v))return v.join(' | '); return v??''; }
function numeric(v){ return typeof v==='number'&&Number.isFinite(v)?v:null; }
function mean(a){const xs=a.filter(x=>Number.isFinite(x));return xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:null;}
function pearson(xs,ys){const pairs=xs.map((x,i)=>[x,ys[i]]).filter(([x,y])=>Number.isFinite(x)&&Number.isFinite(y));if(pairs.length<5)return null;const mx=mean(pairs.map(p=>p[0])),my=mean(pairs.map(p=>p[1]));let num=0,dx=0,dy=0;for(const [x,y] of pairs){const a=x-mx,b=y-my;num+=a*b;dx+=a*a;dy+=b*b;}return dx&&dy?num/Math.sqrt(dx*dy):null;}
function pct(c,n){return n?Math.round(c/n*1000)/10:'';}
function addSummaryRow(out,group,qid,block,question,vals,surveys=''){
  const clean=vals.filter(v=>!(v&&typeof v==='object'&&v.skipped)),nums=clean.map(numeric).filter(x=>x!==null),n=nums.length,dist=Array.from({length:11},(_,i)=>nums.filter(x=>x===i).length);
  out.push([group,qid,block,question,surveys,clean.length,n?Math.round(mean(nums)*100)/100:'',pct((dist[1]||0)+(dist[2]||0),n),pct(dist[3]||0,n),pct((dist[4]||0)+(dist[5]||0),n),...dist]);
}
export function questionDictionary(config){const rows=[];for(const [sid,s] of Object.entries(config.surveys)){for(const b of s.blocks){for(const q of b.questions){rows.push({survey_id:sid,family:s.family,locale:s.locale,block_id:b.id,block:b.title,question_id:q.id,source_number:q.sourceNumber??'',question:q.text,kind:q.kind,required:!!q.required,min:q.min??'',max:q.max??'',options:(q.options||q.special||[]).join(' | ')})}}}for(const [loc,b] of Object.entries(config.finalTrustBlocks||{})){for(const q of b.questions)rows.push({survey_id:'FINAL_TRUST',family:'trust',locale:loc,block_id:b.id,block:b.title,question_id:q.id,source_number:'',question:q.text,kind:q.kind,required:!!q.required,min:q.min??'',max:q.max??'',options:(q.options||q.special||[]).join(' | ')})}return rows;}
export function buildAnalysis(config,sessions,answers){
  const dict=questionDictionary(config),qmeta=new Map(),canonical=new Map();
  for(const r of dict){const k=r.survey_id+'|'+r.question_id;if(!qmeta.has(k))qmeta.set(k,r);const ck=r.family+'|'+r.question_id;if(!canonical.has(ck)||r.locale==='ru')canonical.set(ck,r);}
  const sessionMap=new Map(sessions.map(s=>[s.id,s]));
  const ansBySession=new Map();for(const a of answers){if(!ansBySession.has(a.session_id))ansBySession.set(a.session_id,[]);ansBySession.get(a.session_id).push(a);}
  const allQ=[...new Set(dict.filter(r=>r.survey_id!=='FINAL_TRUST').map(r=>r.question_id).concat((config.finalTrustBlocks?.ru?.questions||[]).map(q=>q.id)))];
  const wideHeader=['session_id','flow','survey_id','family','language','workplace','tenure','completed','started_at','completed_at','duration_minutes',...allQ];
  const wide=[wideHeader];
  for(const s of sessions){const amap=new Map((ansBySession.get(s.id)||[]).map(a=>[a.question_id,scalar(a.answer)]));const sv=config.surveys[s.survey_id]||{};const dur=s.completed_at&&s.started_at?Math.round((new Date(s.completed_at)-new Date(s.started_at))/60000*10)/10:'';wide.push([s.id,s.flow||'',s.survey_id||'',sv.family||'',s.locale||'',s.workplace||'',s.tenure||'',!!s.completed,s.started_at?new Date(s.started_at).toISOString():'',s.completed_at?new Date(s.completed_at).toISOString():'',dur,...allQ.map(q=>amap.get(q)??'')]);}
  const long=[['session_id','survey_id','family','language','workplace','tenure','block_id','question_id','question','answer','numeric_answer','submitted_at']];
  for(const a of answers){const s=sessionMap.get(a.session_id)||{},sv=config.surveys[s.survey_id]||{},m=qmeta.get((s.survey_id||'')+'|'+a.question_id)||dict.find(x=>x.question_id===a.question_id)||{};long.push([a.session_id,s.survey_id||'',sv.family||'',s.locale||'',s.workplace||'',s.tenure||'',a.block_id,a.question_id,m.question||'',scalar(a.answer),numeric(a.answer)??'',a.submitted_at?new Date(a.submitted_at).toISOString():'']);}
  const qdict=[['survey_id','family','language','block','question_id','source_number','question','type','required','min','max','options'],...dict.map(r=>[r.survey_id,r.family,r.locale,r.block,r.question_id,r.source_number,r.question,r.kind,r.required,r.min,r.max,r.options])];

  const summary=[['survey_id','question_id','block','question','surveys','N','mean','negative_1_2_pct','neutral_3_pct','positive_4_5_pct','0','1','2','3','4','5','6','7','8','9','10']];
  for(const [sid,sv] of Object.entries(config.surveys)){const ss=sessions.filter(s=>s.survey_id===sid),mapById=new Map();for(const s of ss)for(const a of ansBySession.get(s.id)||[]){if(!mapById.has(a.question_id))mapById.set(a.question_id,[]);mapById.get(a.question_id).push(a.answer);}for(const b of sv.blocks)for(const q of b.questions)addSummaryRow(summary,sid,q.id,b.title,q.text,mapById.get(q.id)||[],sid);const tb=config.finalTrustBlocks?.ru;for(const q of tb?.questions||[])addSummaryRow(summary,sid,q.id,tb.title,q.text,mapById.get(q.id)||[],sid);}

  // Cross-version/cross-language summary by family + stable question id.
  // This combines identical office-core questions across full/short versions and production-simple questions across RU/UZ/KO.
  const summaryCommon=[['family','question_id','block','question_ru_or_canonical','surveys','N','mean','negative_1_2_pct','neutral_3_pct','positive_4_5_pct','0','1','2','3','4','5','6','7','8','9','10']];
  const commonVals=new Map(),commonSurveys=new Map();
  for(const a of answers){const s=sessionMap.get(a.session_id),sv=s&&config.surveys[s.survey_id];if(!sv)continue;const fam=String(a.question_id).startsWith('TRUST_')?'TRUST':sv.family;const key=fam+'|'+a.question_id;if(!commonVals.has(key))commonVals.set(key,[]);commonVals.get(key).push(a.answer);if(!commonSurveys.has(key))commonSurveys.set(key,new Set());commonSurveys.get(key).add(s.survey_id);}
  for(const [key,vals] of commonVals){const [family,...rest]=key.split('|'),qid=rest.join('|'),m=canonical.get(key)||canonical.get('trust|'+qid)||{};addSummaryRow(summaryCommon,family,qid,m.block||'',m.question||qid,vals,[...(commonSurveys.get(key)||[])].join(' | '));}

  const indices=[['session_id','survey_id','family','block_id','block','N_scale_1_5','mean_1_5','index_0_100']];
  const blockValsBySurvey=new Map(),blockValsByFamily=new Map(),blockTitleCanonical=new Map();
  for(const s of sessions){const sv=config.surveys[s.survey_id];if(!sv)continue;const amap=new Map((ansBySession.get(s.id)||[]).map(a=>[a.question_id,a.answer]));for(const b of sv.blocks){const qs=b.questions.filter(q=>q.kind==='scale'&&q.min===1&&q.max===5),vals=qs.map(q=>numeric(amap.get(q.id))).filter(x=>x!==null);if(!vals.length)continue;const m=mean(vals),idx=(m-1)/4*100;indices.push([s.id,s.survey_id,sv.family,b.id,b.title,vals.length,Math.round(m*100)/100,Math.round(idx*10)/10]);const sk=s.survey_id+'|'+b.id,fk=sv.family+'|'+b.id;if(!blockValsBySurvey.has(sk))blockValsBySurvey.set(sk,new Map());blockValsBySurvey.get(sk).set(s.id,m);if(!blockValsByFamily.has(fk))blockValsByFamily.set(fk,new Map());blockValsByFamily.get(fk).set(s.id,m);if(!blockTitleCanonical.has(fk)||s.locale==='ru')blockTitleCanonical.set(fk,b.title);}const tb=config.finalTrustBlocks?.[s.locale]||config.finalTrustBlocks?.ru;const tvals=(tb?.questions||[]).map(q=>numeric(amap.get(q.id))).filter(x=>x!==null);if(tvals.length){const m=mean(tvals),idx=(m-1)/4*100,bid='trust',sk=s.survey_id+'|'+bid,fk=sv.family+'|'+bid;indices.push([s.id,s.survey_id,sv.family,bid,tb.title,tvals.length,Math.round(m*100)/100,Math.round(idx*10)/10]);if(!blockValsBySurvey.has(sk))blockValsBySurvey.set(sk,new Map());blockValsBySurvey.get(sk).set(s.id,m);if(!blockValsByFamily.has(fk))blockValsByFamily.set(fk,new Map());blockValsByFamily.get(fk).set(s.id,m);if(!blockTitleCanonical.has(fk)||s.locale==='ru')blockTitleCanonical.set(fk,config.finalTrustBlocks?.ru?.title||tb.title);}}

  const corrQ=[['survey_id','question_a','question_b','N_pairs','pearson_r']];
  for(const [sid,sv] of Object.entries(config.surveys)){const ss=sessions.filter(s=>s.survey_id===sid),qids=[...new Set(sv.blocks.flatMap(b=>b.questions.filter(q=>q.kind==='scale').map(q=>q.id)).concat((config.finalTrustBlocks?.ru?.questions||[]).map(q=>q.id)))],maps=new Map(qids.map(q=>[q,new Map()]));for(const s of ss)for(const a of ansBySession.get(s.id)||[]){if(maps.has(a.question_id)&&numeric(a.answer)!==null)maps.get(a.question_id).set(s.id,a.answer);}for(let i=0;i<qids.length;i++)for(let j=i+1;j<qids.length;j++){const ids=ss.map(s=>s.id).filter(id=>maps.get(qids[i]).has(id)&&maps.get(qids[j]).has(id));if(ids.length<5)continue;const r=pearson(ids.map(id=>maps.get(qids[i]).get(id)),ids.map(id=>maps.get(qids[j]).get(id)));if(r!==null)corrQ.push([sid,qids[i],qids[j],ids.length,Math.round(r*1000)/1000]);}}

  const corrCommon=[['family','question_a','question_b','N_pairs','pearson_r']];
  const families=[...new Set(sessions.map(s=>config.surveys[s.survey_id]?.family).filter(Boolean))];
  for(const family of families){const ss=sessions.filter(s=>config.surveys[s.survey_id]?.family===family),qids=[...new Set(dict.filter(r=>r.family===family&&r.kind==='scale').map(r=>r.question_id).concat((config.finalTrustBlocks?.ru?.questions||[]).map(q=>q.id)))],maps=new Map(qids.map(q=>[q,new Map()]));for(const s of ss)for(const a of ansBySession.get(s.id)||[]){if(maps.has(a.question_id)&&numeric(a.answer)!==null)maps.get(a.question_id).set(s.id,a.answer);}for(let i=0;i<qids.length;i++)for(let j=i+1;j<qids.length;j++){const ids=ss.map(s=>s.id).filter(id=>maps.get(qids[i]).has(id)&&maps.get(qids[j]).has(id));if(ids.length<5)continue;const r=pearson(ids.map(id=>maps.get(qids[i]).get(id)),ids.map(id=>maps.get(qids[j]).get(id)));if(r!==null)corrCommon.push([family,qids[i],qids[j],ids.length,Math.round(r*1000)/1000]);}}

  const corrB=[['survey_id','block_a','block_b','N_pairs','pearson_r']];const bySurvey={};for(const [key,map] of blockValsBySurvey){const [sid,...rest]=key.split('|');(bySurvey[sid]||=[]).push([rest.join('|'),map]);}for(const [sid,arr] of Object.entries(bySurvey)){const sv=config.surveys[sid];const titles=new Map((sv?.blocks||[]).map(b=>[b.id,b.title]));for(let i=0;i<arr.length;i++)for(let j=i+1;j<arr.length;j++){const ids=[...arr[i][1].keys()].filter(id=>arr[j][1].has(id));if(ids.length<5)continue;const r=pearson(ids.map(id=>arr[i][1].get(id)),ids.map(id=>arr[j][1].get(id)));if(r!==null)corrB.push([sid,titles.get(arr[i][0])||arr[i][0],titles.get(arr[j][0])||arr[j][0],ids.length,Math.round(r*1000)/1000]);}}

  const corrBCommon=[['family','block_a','block_b','N_pairs','pearson_r']];const byFamily={};for(const [key,map] of blockValsByFamily){const [fam,...rest]=key.split('|');(byFamily[fam]||=[]).push([rest.join('|'),map]);}for(const [fam,arr] of Object.entries(byFamily)){for(let i=0;i<arr.length;i++)for(let j=i+1;j<arr.length;j++){const ids=[...arr[i][1].keys()].filter(id=>arr[j][1].has(id));if(ids.length<5)continue;const r=pearson(ids.map(id=>arr[i][1].get(id)),ids.map(id=>arr[j][1].get(id)));if(r!==null){const a=blockTitleCanonical.get(fam+'|'+arr[i][0])||arr[i][0],b=blockTitleCanonical.get(fam+'|'+arr[j][0])||arr[j][0];corrBCommon.push([fam,a,b,ids.length,Math.round(r*1000)/1000]);}}}

  const sess=[['session_id','flow','survey_id','family','language','workplace','tenure','completed','started_at','completed_at'],...sessions.map(s=>{const sv=config.surveys[s.survey_id]||{};return [s.id,s.flow||'',s.survey_id||'',sv.family||'',s.locale||'',s.workplace||'',s.tenure||'',!!s.completed,s.started_at?new Date(s.started_at).toISOString():'',s.completed_at?new Date(s.completed_at).toISOString():''];})];
  return [
    {name:'Ответы_по_сессиям',rows:wide},
    {name:'Ответы_LONG',rows:long},
    {name:'Справочник_вопросов',rows:qdict},
    {name:'Сводная_по_версиям',rows:summary},
    {name:'Сводная_общие_вопросы',rows:summaryCommon},
    {name:'Индексы_по_сессиям',rows:indices},
    {name:'Корреляции_вопросов',rows:corrQ},
    {name:'Корреляции_общие',rows:corrCommon},
    {name:'Корреляции_блоков',rows:corrB},
    {name:'Корреляции_блоков_общие',rows:corrBCommon},
    {name:'Сессии',rows:sess}
  ];
}
