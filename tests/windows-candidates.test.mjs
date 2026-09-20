import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWindowsCandidates,validateWindowsSnapshot,windowsObservation,replacementLiteral} from '../desktop/automation/windows-candidates.mjs';

function fixture({windows=1,controls=[]}={}){
  const surfaces=Array.from({length:windows},(_,i)=>({id:`win_${i}`,title:`Document ${i}`,processName:'editor',minimized:false,maximized:false,active:i===0}));
  return {version:'0123456789abcdef0123456789abcdef',windows:surfaces,elements:[...surfaces.map(w=>({id:w.id,windowId:w.id,label:`editor: ${w.title}`,name:w.title,role:'Window',capabilities:['inspect','activate','minimize','close']})),...controls],facts:{selectedWindowId:surfaces[0]?.id??null},metadata:{provider:'synthetic UIA'}};
}
const control=(id,name,capabilities=['invoke'])=>({id,windowId:'win_0',name,label:name,role:'Button',capabilities});

test('every unselected window remains inspectable across candidate pages beyond 96 actions',()=>{
  const snapshot=fixture({windows:64,controls:Array.from({length:130},(_,i)=>control(`button_${i}`,`Option ${i}`))});const all=new Map();const first=buildWindowsCandidates(snapshot,'Сверни окно');
  assert.ok(first.total>96);assert.ok(first.pages>1);
  const windowIds=snapshot.windows.filter(w=>w.id!==snapshot.facts.selectedWindowId).map(w=>w.id).sort();
  for(let page=0;page<first.pages;page++){
    const batch=buildWindowsCandidates(snapshot,'Сверни окно',{page});
    assert.ok(batch.candidates.length<=96);assert.equal(batch.page,page);
    assert.deepEqual(batch.candidates.filter(c=>c.operation==='inspect').map(c=>c.targetId).sort(),windowIds);
    for(const c of batch.candidates){assert.ok(snapshot.elements.some(e=>e.id===c.targetId&&e.capabilities.includes(c.operation)));all.set(c.id,c);}
  }
  assert.equal(all.size,first.total);assert.equal(first.total,196);
  assert.equal(buildWindowsCandidates(snapshot,'x',{page:999}).page,first.pages-1);
});

test('dangerous controls are omitted while safe controls and window inspection remain',()=>{
  const danger=['Delete document','Send email','Pay now','Install extension','Password','Удалить','Отправить','Купить','Сбросить настройки','Вход'];
  const snapshot=fixture({controls:[...danger.map((name,i)=>control(`danger_${i}`,name)),control('play','Play'),control('pause','Пауза')]});
  const result=buildWindowsCandidates(snapshot,'Delete document');
  assert.equal(result.candidates.some(c=>c.targetId.startsWith('danger_')),false);
  assert.ok(result.candidates.some(c=>c.targetId==='play'));assert.ok(result.candidates.some(c=>c.targetId==='pause'));
  assert.ok(result.candidates.some(c=>c.operation==='activate'&&c.targetId==='win_0'));
});

test('identical tab names remain distinguishable by target and observed visual order',()=>{
  const snapshot=fixture({controls:[1,2].map(n=>({...control(`tab_${n}`,'ВКонтакте',['select']),role:'TabItem',order:n,orderIsPartial:true,group:'Tabs'}))});
  const tabs=buildWindowsCandidates(snapshot,'Выбери первую вкладку ВКонтакте').candidates.filter(c=>c.operation==='select');
  assert.equal(new Set(tabs.map(t=>t.label)).size,2);
  for(const tab of tabs){assert.match(tab.label,/TabItem; visual order [12]/);assert.ok(tab.label.includes(tab.targetId));assert.match(tab.label,/may be incomplete/);}
});

test('large observation keeps parseable records, target IDs and explicit coverage limits',()=>{
  const snapshot=fixture({controls:Array.from({length:160},(_,i)=>({...control(`button_${i}`,'Private UI label '.repeat(20)),selected:false}))});
  snapshot.metadata.truncated=true;
  const batch=buildWindowsCandidates(snapshot,'Private');
  const observation=windowsObservation(snapshot,batch);
  assert.ok(observation.summary.length<=16000);
  const line=observation.summary.split('\n').find(l=>l.startsWith('Observed controls: '));
  const records=JSON.parse(line.slice('Observed controls: '.length));
  assert.ok(records.length>0&&records.length<160);assert.ok(records.every(r=>r.id));
  assert.match(observation.summary,/control descriptions omitted/);assert.match(observation.summary,/Observation is truncated/);
  assert.match(observation.summary,/hyperlinks and bookmarks are not tabs/);
});

test('candidate IDs are stable for identical observations and invalidated by a new version',()=>{
  const snapshot=fixture({controls:[control('play','Play')]});
  const first=buildWindowsCandidates(snapshot,'Play');const same=buildWindowsCandidates(structuredClone(snapshot),'Play');
  assert.deepEqual(first,same);
  const next=buildWindowsCandidates({...snapshot,version:'abcdef0123456789abcdef0123456789'},'Play');
  assert.deepEqual(first.candidates.map(c=>[c.targetId,c.operation]).sort(),next.candidates.map(c=>[c.targetId,c.operation]).sort());
  assert.ok(first.candidates.every(c=>!next.candidates.some(n=>n.id===c.id)));
});

test('snapshot validation rejects malformed identity, duplicates, unknown operations and oversized payloads',()=>{
  const good=fixture();assert.equal(validateWindowsSnapshot(good),good);
  const cases=[null,{}, {...good,version:'not-hex'}, {...good,version:'1234'}, {...good,windows:{}}, {...good,elements:{}},
    {...good,elements:[{...good.elements[0],id:'../escape'}]},
    {...good,elements:[good.elements[0],good.elements[0]]},
    {...good,elements:[{...good.elements[0],label:'x'.repeat(501)}]},
    {...good,elements:[{...good.elements[0],capabilities:['shell']}]},
    {...good,elements:Array.from({length:301},(_,i)=>control(`c_${i}`,'Play'))},
    fixture({windows:65}),
  ];
  for(const value of cases)assert.throws(()=>validateWindowsSnapshot(value),{code:'WINDOWS_INVALID_SNAPSHOT'});
});

test('observation preserves UI state and tab order without projecting arbitrary private fields',()=>{
  const snapshot=fixture({controls:[{...control('tab','VK feed',['select']),role:'TabItem',selected:true,order:2,password:'never project me',value:'private user text'}]});
  snapshot.metadata.truncated=true;
  const observation=windowsObservation(snapshot,{omitted:15});
  assert.equal(observation.app,'Windows');assert.match(observation.summary,/Document 0/);
  assert.match(observation.summary,/"selected":true/);assert.match(observation.summary,/"order":2/);
  assert.match(observation.summary,/Observation is truncated/);assert.match(observation.summary,/15 further action options/);
  assert.doesNotMatch(observation.summary,/never project me|private user text/);
  assert.ok(observation.summary.length<=16000);
});

test('window identities must link to unique real Window elements and coherent facts',()=>{
  const good=fixture();
  const cases=[{...good,windows:[null]}, {...good,windows:[good.windows[0],good.windows[0]]},
    {...good,windows:[{...good.windows[0],id:'win_unknown'}]},
    {...good,windows:[{...good.windows[0],active:'yes'}]},
    {...good,windows:[{...good.windows[0],title:'x'.repeat(501)}]},
    {...good,windows:[{...good.windows[0],processName:null}]},
    {...good,elements:[{...good.elements[0],role:'Button'}]},
    {...good,facts:{selectedWindowId:'win_unknown'}}, {...good,facts:null},
    {...good,windows:[]},
  ];
  for(const value of cases)assert.throws(()=>validateWindowsSnapshot(value),{code:'WINDOWS_INVALID_SNAPSHOT'});
  // A dangerous control cannot exempt itself from filtering just by being
  // mentioned in the separate windows array.
  const fake=control('delete','Delete everything');
  assert.throws(()=>buildWindowsCandidates({...good,elements:[...good.elements,fake],windows:[...good.windows,{...good.windows[0],id:fake.id}]},'Delete everything'),{code:'WINDOWS_INVALID_SNAPSHOT'});
});

test('empty desktop yields no invented applications or operations',()=>{
  const snapshot=fixture({windows:0});
  assert.deepEqual(buildWindowsCandidates(snapshot,'Открой Music'),{candidates:[],page:0,pages:1,total:0,omitted:0});
  assert.match(windowsObservation(snapshot).summary,/none; inspect the relevant window/);
});

test('installed-app launch candidates contain only IDs and labels, never executable paths',()=>{
  const app={id:'app_0123456789abcdef01234567',name:'Music Player',processName:'music-player',exe:'C:\\Synthetic Programs\\Music Player\\music-player.exe',arguments:'--private-argument'};
  const result=buildWindowsCandidates(fixture(),'Открой Music Player',{apps:[app]});
  const launch=result.candidates.find(c=>c.operation==='launch');
  assert.ok(launch);assert.equal(launch.targetId,app.id);assert.match(launch.label,/Music Player/);
  assert.deepEqual(Object.keys(launch).sort(),['id','label','operation','targetId']);
  assert.doesNotMatch(JSON.stringify(result),/Synthetic Programs|\.exe|private-argument/);
});

test('only a matching process hides duplicate launch; unrelated window titles cannot',()=>{
  const snapshot=fixture();
  const apps=[
    {id:'app_0123456789abcdef01234567',name:'Editor Application',processName:'EDITOR'},
    {id:'app_abcdef0123456789abcdef01',name:'Document 0',processName:'different-executable'},
    {id:'app_aaaaaaaaaaaaaaaaaaaaaaaa',name:'Music Player',processName:'music-player'},
  ];
  const result=buildWindowsCandidates(snapshot,'Открой Music Player',{apps});
  assert.deepEqual(result.candidates.filter(c=>c.operation==='launch').map(c=>c.targetId).sort(),[apps[1].id,apps[2].id].sort());
  assert.ok(result.candidates.some(c=>c.operation==='activate'&&c.targetId==='win_0'));
});

test('malformed installed-app records never create launch actions',()=>{
  const valid={id:'app_0123456789abcdef01234567',name:'Music Player',processName:'music-player'};
  const apps=[null,{}, {...valid,id:'../bad'}, {...valid,name:''}, {...valid,name:'x'.repeat(201)}, {...valid,processName:null}];
  assert.equal(buildWindowsCandidates(fixture(),'Открой Music Player',{apps}).candidates.some(c=>c.operation==='launch'),false);
});

test('only the selected window exposes effects, while other windows expose inspection',()=>{
  const snapshot=fixture({windows:3});
  const selected=buildWindowsCandidates(snapshot,'Сверни окно').candidates;
  assert.equal(selected.some(c=>c.targetId==='win_0'&&c.operation==='inspect'),false);
  assert.deepEqual(selected.filter(c=>c.targetId==='win_0').map(c=>c.operation).sort(),['activate','close','minimize']);
  for(const target of ['win_1','win_2'])assert.deepEqual(selected.filter(c=>c.targetId===target).map(c=>c.operation),['inspect']);
  const none=buildWindowsCandidates({...snapshot,facts:{selectedWindowId:null}},'Сверни окно').candidates;
  assert.equal(none.length,3);assert.ok(none.every(c=>c.operation==='inspect'));
});

const focusedEdit=(patch={})=>({...control('focused_input','Focused editable field',['replace_text']),role:'Edit',hasKeyboardFocus:true,isPassword:false,readOnly:false,enabled:true,offscreen:false,supportsValuePattern:true,...patch});
const inputCandidates=(snapshot,command='замени текст на «Точный текст»')=>buildWindowsCandidates(snapshot,command).candidates.filter(c=>c.operation==='replace_text');

test('replacement literal is anchored to the entire explicit command and preserved exactly',()=>{
  for(const [command,expected] of [
    ['замени текст на «Hello, Джефф!»','Hello, Джефф!'],
    [' ЗАМЕНИ ТЕКСТ НА "  Exact Text  ". ','  Exact Text  '],
    ['замени текст на «»',''],
    ['замени текст на «первая\nвторая»','первая\nвторая'],
  ])assert.equal(replacementLiteral(command),expected);
  for(const command of [
    'не замени текст на «Текст»','объясни фразу: замени текст на «Текст»',
    'замени текст на «Текст», затем отправь','замени текст на «один» и «два»',
    'допиши «Текст»','замени текст на Текст','замени текст на «Текст"',
    'замени текст на "первая\nвторая"',
  ])assert.equal(replacementLiteral(command),null,command);
});

test('replacement candidates keep the source literal as fixed executor arguments without inferred text',()=>{
  const snapshot=fixture({controls:[focusedEdit({value:'old private value',text:'invented by model',args:{text:'invented argument'}})]});
  const [candidate]=inputCandidates(snapshot,'замени текст на «  hello  »');
  assert.equal(candidate.targetId,'focused_input');assert.deepEqual(candidate.args,{text:'  hello  '});
  assert.doesNotMatch(JSON.stringify(candidate),/old private value|invented by model|invented argument/);
  assert.match(candidate.label,/Заменить всё содержимое/);
  assert.deepEqual(inputCandidates(structuredClone(snapshot),'замени текст на «  hello  »'),[candidate]);
  assert.notEqual(inputCandidates(snapshot,'замени текст на «hello»')[0].id,candidate.id);
  assert.deepEqual(inputCandidates(snapshot,'напиши что-нибудь хорошее'),[]);
});

test('text replacement requires explicit boolean focus, nonpassword and writable state',()=>{
  for(const patch of [
    {hasKeyboardFocus:false},{hasKeyboardFocus:undefined},{hasKeyboardFocus:'true'},
    {isPassword:true},{isPassword:undefined},{isPassword:0},
    {readOnly:true},{readOnly:undefined},{readOnly:'false'},
  ])assert.deepEqual(inputCandidates(fixture({controls:[focusedEdit(patch)]})),[],JSON.stringify(patch));
  assert.equal(inputCandidates(fixture({controls:[focusedEdit()]})).length,1);
});

test('text replacement requires a visible enabled ValuePattern Edit in the selected active window',()=>{
  for(const patch of [
    {role:'Button'},{enabled:false},{enabled:undefined},{offscreen:true},{offscreen:undefined},
    {supportsValuePattern:false},{supportsValuePattern:undefined},{windowId:'missing_window'},{windowId:'win_1'},
  ])assert.deepEqual(inputCandidates(fixture({windows:2,controls:[focusedEdit(patch)]})),[],JSON.stringify(patch));
  const inactive=fixture({controls:[focusedEdit()]});inactive.windows[0].active=false;
  assert.deepEqual(inputCandidates(inactive),[]);
  const unselected=fixture({controls:[focusedEdit()]});unselected.facts.selectedWindowId=null;
  assert.deepEqual(inputCandidates(unselected),[]);
});

test('layout candidates use only installed English and Russian with fixed unique arguments',()=>{
  const snapshot=fixture();snapshot.elements[0].capabilities.push('set_keyboard_language');
  snapshot.windows[0].availableKeyboardLanguages=['English','Russian','German','english',null];
  const candidates=buildWindowsCandidates(snapshot,'смени раскладку на английскую').candidates.filter(c=>c.operation==='set_keyboard_language');
  assert.deepEqual(candidates.map(c=>c.args.language).sort(),['English','Russian']);
  for(const candidate of candidates){assert.equal(candidate.targetId,'win_0');assert.deepEqual(Object.keys(candidate.args),['language']);assert.ok(candidate.label.includes(candidate.args.language));}
  const same=buildWindowsCandidates(snapshot,'выбери раскладку French').candidates.filter(c=>c.operation==='set_keyboard_language');
  assert.deepEqual(same.map(c=>[c.id,c.args]).sort(),candidates.map(c=>[c.id,c.args]).sort());
  snapshot.windows[0].availableKeyboardLanguages=['Russian'];
  assert.deepEqual(buildWindowsCandidates(snapshot,'English').candidates.filter(c=>c.operation==='set_keyboard_language').map(c=>c.args.language),['Russian']);
});

test('layout does not invent an installed language or expose an inactive window effect',()=>{
  const snapshot=fixture({windows:2});for(const element of snapshot.elements)element.capabilities.push('set_keyboard_language');
  assert.equal(buildWindowsCandidates(snapshot,'English').candidates.some(c=>c.operation==='set_keyboard_language'),false);
  for(const window of snapshot.windows)window.availableKeyboardLanguages=['English'];
  const available=buildWindowsCandidates(snapshot,'English').candidates.filter(c=>c.operation==='set_keyboard_language');
  assert.deepEqual(available.map(c=>c.targetId),['win_0']);
  snapshot.windows[0].active=false;
  assert.equal(buildWindowsCandidates(snapshot,'English').candidates.some(c=>c.operation==='set_keyboard_language'),false);
});

test('duplicate installed keyboard language records cannot produce duplicate action IDs',()=>{
  const snapshot=fixture();snapshot.elements[0].capabilities.push('set_keyboard_language');
  snapshot.windows[0].availableKeyboardLanguages=['English','English','Russian','Russian'];
  const candidates=buildWindowsCandidates(snapshot,'English').candidates.filter(c=>c.operation==='set_keyboard_language');
  assert.equal(candidates.length,2);assert.equal(new Set(candidates.map(c=>c.id)).size,candidates.length);
});
