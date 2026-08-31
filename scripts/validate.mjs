import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(__dirname,'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'config','surveys.json'),'utf8'));
const officeManifest=JSON.parse(fs.readFileSync(path.join(root,'reference','office_100_manifest.json'),'utf8'));
const businessManifest=JSON.parse(fs.readFileSync(path.join(root,'reference','production_business_manifest.json'),'utf8'));
const simpleManifest=JSON.parse(fs.readFileSync(path.join(root,'reference','production_simple_source_manifest.json'),'utf8'));
const errors=[];

function splitOptions(s){return typeof s==='string'?s.split(';').map(x=>x.trim()).filter(Boolean):[];}
function mapQuestions(s){return s.blocks.flatMap(b=>b.questions.map(q=>({block:b.title,q})));}
function expectedKind(type){if(type.includes('Длинный текст'))return'text';if(type.includes('Флажки')||type.includes('Несколько вариантов'))return'multi';if(type.includes('Один вариант'))return'single';if(type.includes('Шкала'))return'scale';return'unknown';}
function expectedMax(type,text,opts){const m=(type+' '+text).match(/(?:до|не больше)\s*(\d+)/i);return m?Number(m[1]):99;}
function sourceOnly(s){return mapQuestions(s).filter(x=>Number.isInteger(x.q.sourceNumber));}

// General integrity.
for(const [sid,s] of Object.entries(config.surveys)){
  const seen=new Set();
  for(const {q} of mapQuestions(s)){
    if(!q.id||!q.text||!q.kind)errors.push(`${sid}: invalid question`);
    if(seen.has(q.id))errors.push(`${sid}: duplicate question id ${q.id}`);seen.add(q.id);
    if(q.kind==='scale'&&(!Number.isInteger(q.min)||!Number.isInteger(q.max)))errors.push(`${sid}/${q.id}: invalid scale`);
    if(['single','multi'].includes(q.kind)&&!Array.isArray(q.options))errors.push(`${sid}/${q.id}: options missing`);
  }
}

// Office must remain the single 100-step version and exactly match its Excel manifest.
if(config.surveys.office_short_ru)errors.push('office_short_ru must not exist');
const officeFamily=Object.values(config.surveys).filter(s=>s.family==='OFFICE');
if(officeFamily.length!==1||officeFamily[0]?.id!=='office_full_ru')errors.push('office must have only office_full_ru');
const office=config.surveys.office_full_ru;
const officeItems=mapQuestions(office);const officeById=new Map(officeItems.map(x=>[x.q.id,x]));
for(const q of config.finalTrustBlocks.ru.questions)officeById.set(q.id,{block:'Финал',q});
if(officeManifest.questionCount!==100||officeById.size!==100)errors.push(`office: expected exactly 100 questions incl trust; manifest=${officeManifest.questionCount}, site=${officeById.size}`);
for(const m of officeManifest.questions){
  const f=officeById.get(m.id);if(!f){errors.push(`office missing ${m.id}`);continue;}
  if(f.q.text!==m.text)errors.push(`office ${m.id}: wording differs from Excel`);
  if(Boolean(f.q.required)!==Boolean(m.required))errors.push(`office ${m.id}: required differs`);
  if(f.block!==m.block)errors.push(`office ${m.id}: block differs`);
}
const corp=office.blocks.find(b=>b.title==='Корпоратив');if(!corp||corp.questions.length!==7)errors.push('office corporate block must contain 7 questions');

// Production set must contain only RU business + KZ simplified.
for(const sid of ['production_simple_ru','production_simple_uz','production_simple_ko','production_business_kk'])if(config.surveys[sid])errors.push(`${sid} must not exist`);
const business=config.surveys.production_business_ru;
const simpleKk=config.surveys.production_simple_kk;
if(!business)errors.push('production_business_ru missing');
if(!simpleKk)errors.push('production_simple_kk missing');
if(business?.locale!=='ru')errors.push('production_business_ru locale must be ru');
if(simpleKk?.locale!=='kk')errors.push('production_simple_kk locale must be kk');

function validateAgainstRussianSource(site, manifest, prefix, translated=false){
  const items=sourceOnly(site);
  if(items.length!==manifest.questionCount)errors.push(`${site.id}: source question count ${items.length} != ${manifest.questionCount}`);
  const byNum=new Map(items.map(x=>[x.q.sourceNumber,x]));
  for(const m of manifest.questions){
    const f=byNum.get(m.number);if(!f){errors.push(`${site.id}: missing source question ${m.number}`);continue;}
    const kind=expectedKind(m.type),opts=splitOptions(m.options);
    if(f.q.kind!==kind)errors.push(`${site.id} #${m.number}: kind ${f.q.kind} != ${kind}`);
    const expectedReq=String(m.required).toLowerCase().startsWith('да');
    if(Boolean(f.q.required)!==expectedReq)errors.push(`${site.id} #${m.number}: required differs`);
    if(!translated){
      if(f.block!==m.block)errors.push(`${site.id} #${m.number}: block differs`);
      if(f.q.text!==m.text)errors.push(`${site.id} #${m.number}: wording differs from final Excel`);
      if(['single','multi'].includes(kind)&&JSON.stringify(f.q.options)!==JSON.stringify(opts))errors.push(`${site.id} #${m.number}: options differ from final Excel`);
    } else {
      if(f.q.text===m.text)errors.push(`${site.id} #${m.number}: Kazakh translation was not applied`);
      if(['single','multi'].includes(kind)&&f.q.options.length!==opts.length)errors.push(`${site.id} #${m.number}: translated option count differs`);
    }
    if(kind==='multi'){
      const ex=expectedMax(m.type,m.text,opts);if(f.q.maxSelections!==ex)errors.push(`${site.id} #${m.number}: max selections ${f.q.maxSelections} != ${ex}`);
    }
    if(kind==='scale'){
      const min=m.number===1?0:1,max=m.number===1?10:5;if(f.q.min!==min||f.q.max!==max)errors.push(`${site.id} #${m.number}: scale differs`);
    }
  }
}
validateAgainstRussianSource(business,businessManifest,'PRODB',false);
validateAgainstRussianSource(simpleKk,simpleManifest,'PRODS',true);

// Previously agreed location question remains in both production routes as one extra technical question.
for(const s of [business,simpleKk]){
  const loc=mapQuestions(s).find(x=>x.q.id==='PRODUCTION_WORK_LOCATION');
  if(!loc)errors.push(`${s.id}: PRODUCTION_WORK_LOCATION missing`);
  if(mapQuestions(s).filter(x=>x.q.id==='PRODUCTION_WORK_LOCATION').length!==1)errors.push(`${s.id}: location question duplicated`);
}
if(mapQuestions(business).length!==businessManifest.questionCount+1)errors.push(`production_business_ru: expected ${businessManifest.questionCount+1} incl location`);
if(mapQuestions(simpleKk).length!==simpleManifest.questionCount+1)errors.push(`production_simple_kk: expected ${simpleManifest.questionCount+1} incl location`);

// Conditional routing from final production files.
const bByNum=new Map(sourceOnly(business).map(x=>[x.q.sourceNumber,x.q]));
for(let n=43;n<=48;n++)if(JSON.stringify(bByNum.get(n)?.showIf)!==JSON.stringify({questionId:'PRODB_042',equals:'Да'}))errors.push(`business #${n}: dorm branch differs`);
for(let n=50;n<=51;n++)if(JSON.stringify(bByNum.get(n)?.showIf)!==JSON.stringify({questionId:'PRODB_049',equals:'Да'}))errors.push(`business #${n}: vacuum branch differs`);
if(JSON.stringify(bByNum.get(54)?.showIf)!==JSON.stringify({questionId:'PRODB_053',equals:'Да'}))errors.push('business #54: night branch differs');
const kByNum=new Map(sourceOnly(simpleKk).map(x=>[x.q.sourceNumber,x.q]));
for(let n=40;n<=44;n++)if(JSON.stringify(kByNum.get(n)?.showIf)!==JSON.stringify({questionId:'PRODS_039',equals:'Иә'}))errors.push(`kk #${n}: dorm branch differs`);
for(let n=46;n<=47;n++)if(JSON.stringify(kByNum.get(n)?.showIf)!==JSON.stringify({questionId:'PRODS_045',equals:'Иә'}))errors.push(`kk #${n}: vacuum branch differs`);
if(JSON.stringify(kByNum.get(50)?.showIf)!==JSON.stringify({questionId:'PRODS_049',equals:'Иә'}))errors.push('kk #50: night branch differs');

// Languages and routing contract.
for(const loc of ['ru','kk'])if(!config.ui[loc])errors.push(`ui ${loc} missing`);
for(const loc of ['ru','kk'])for(const id of ['OFF_TRUST_01','OFF_TRUST_02','OFF_TRUST_03'])if(!config.finalTrustBlocks[loc]?.questions.some(q=>q.id===id))errors.push(`${loc}: ${id} missing`);
const serverJs=fs.readFileSync(path.join(root,'server','index.js'),'utf8');
const appJs=fs.readFileSync(path.join(root,'public','app.js'),'utf8');
if(!serverJs.includes("languages:[{id:'ru',label:'Русский'},{id:'kk',label:'Қазақша'}]"))errors.push('server language list must be RU/KK');
if(serverJs.includes("step:'version'")||serverJs.includes("/api/version"))errors.push('production version chooser must not exist');
if(appJs.includes('renderVersion')||appJs.includes("step==='version'"))errors.push('frontend production version chooser must not exist');
if(!serverJs.includes("workplace==='office'?'office_full_ru':'production_business_ru'"))errors.push('RU production must route directly to business survey');
if(!serverJs.includes("locale==='kk'?'production_simple_kk'"))errors.push('KK must route directly to simplified survey');

if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log('OK');
console.log('Languages: Русский / Қазақша');
console.log('RU -> office: ONE office survey (100 questions incl trust)');
console.log('RU -> production: business final 28.08, 85 source + 1 location + 3 trust');
console.log('KK -> production simplified directly, 76 source + 1 location + 3 trust');
console.log('No production version chooser. No Uzbek/Korean routes.');
for(const [sid,s] of Object.entries(config.surveys))console.log(`${sid}: ${s.blocks.length} blocks, ${mapQuestions(s).length} base questions`);
