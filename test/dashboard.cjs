const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(id='') { this.id=id; this.dataset={}; this.children=[]; this.listeners={}; this.attributes={}; this.style={}; this.hidden=false; this._textContent=''; this.className=''; this._html=''; this.classList={add:()=>{},remove:()=>{},contains:()=>false}; }
  set textContent(value) { this._textContent=String(value); }
  get textContent() { return this._textContent; }
  set innerHTML(value) { this._html=value; }
  get innerHTML() { return this._html; }
  addEventListener(type,fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(name,value) { this.attributes[name]=String(value); }
  getAttribute(name) { return this.attributes[name]; }
  appendChild(node) { this.children.push(node); return node; }
  insertBefore(node,at) { if(node.parent===this) this.children.splice(this.children.indexOf(node),1); const ix=at?this.children.indexOf(at):-1; if(ix<0)this.children.push(node);else this.children.splice(ix,0,node); node.parent=this; return node; }
  remove() { if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1); }
  replaceChildren() { this.children=[]; }
  querySelector() { return null; }
  getBoundingClientRect() { return {left:10,right:200,top:10,bottom:40}; }
  click() { for(const fn of this.listeners.click||[])fn({}); }
}

test('dashboard counts, keyed rows, keyboard activation and collapse state', () => {
  const ids=['tooltip','running','waiting','failed','connectionStatus','codex','codexContent','codexCount','codexHint','active','activeContent','activeCount','idle','idleContent','idleCount','history','historyContent','historyCount','historyMore','summary','syncLabel'];
  const els=Object.fromEntries(ids.map(id=>[id,new Element(id)]));
  const sections=['codex','active','idle','history'].map(id=>{const e=new Element(id);e.dataset.sectionToggle=id;e.listeners={};e.querySelector=()=>new Element('chevron');return e;});
  const winEvents={}; const messages=[]; const saved={};
  const document={getElementById:id=>els[id],createElement:()=>new Element(),querySelectorAll:q=>q==='[data-section-toggle]'?sections:q==='.task'?['codex','active','idle','history'].flatMap(id=>els[id].children):[],querySelector:q=>q==='.task:hover'?null:q.startsWith('[data-section-toggle=')?sections.find(x=>q.includes(x.dataset.sectionToggle)):null};
  const context={acquireVsCodeApi:()=>({postMessage:m=>messages.push(m),getState:()=>saved.value,setState:v=>saved.value=v}),document,window:{innerWidth:400,innerHeight:600,addEventListener:(t,f)=>winEvents[t]=f},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},Date,console};
  vm.createContext(context); vm.runInContext(fs.readFileSync('resources/dashboard.js','utf8'),context);
  const state={type:'state',codexAvailable:true,codexLastSync:Date.now(),codex:[{id:'c1',name:'批准任务',source:'vscode',status:'waiting',waitingReason:'approval',startTime:Date.now()}],active:[{id:'a1',terminalId:'t1',terminalName:'zsh',name:'Task',type:'shell',status:'quiet',startTime:Date.now(),recentOutput:[]}],idle:[],history:Array.from({length:6},(_,i)=>({id:`h${i}`,terminalId:'closed',terminalName:'old',name:'Task',type:'shell',status:i?'completed':'failed',startTime:Date.now(),recentOutput:[]}))};
  winEvents.message({data:state});
  assert.equal(els.running.textContent,'1'); assert.equal(els.waiting.textContent,'1'); assert.equal(els.failed.textContent,'1');
  assert.match(els.codex.children[0].innerHTML,/status waiting/);
  const row=els.active.children[0]; assert.equal(row.dataset.id,'a1'); assert.equal(row.getAttribute('role'),'button');
  const key=row.listeners.keydown[0]; let prevented=false; key({key:'Enter',preventDefault(){prevented=true}}); assert.equal(prevented,true); assert.equal(messages.at(-1).terminalId,'t1');
  state.active[0]={...state.active[0],status:'running',recentOutput:['new']}; winEvents.message({data:state}); assert.equal(els.active.children[0],row);
  assert.equal(els.history.children.length,5); assert.equal(els.historyMore.hidden,false);
  els.historyMore.click(); assert.equal(els.history.children.length,6);
  sections.find(x=>x.dataset.sectionToggle==='active').listeners.click[0](); assert.ok(saved.value.collapsedSections.includes('active'));
});
