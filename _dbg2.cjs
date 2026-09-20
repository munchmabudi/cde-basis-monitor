const fs=require('fs');
const h=fs.readFileSync('capital_explorer.html','utf8');
let js=h.match(/<script>([\s\S]*?)<\/script>/)[1];
// instrument: count render calls and log strat value
js=js.replace('function render(){', 'let __n=0; function render(){ __n++; const __s=document.getElementById("strategy").value; if(__s==="__probe__")console.log("render#"+__n+" strat="+__s);');
// also expose __n and a probe
js+='\nglobal.__getN=()=>__n;';
const store={};
function makeEl(defVal){ return { _children:[], innerHTML:"", textContent:"", value:defVal||"", style:{}, className:"", classList:{add(){},remove(){}}, _change:null, set onclick(f){}, set onchange(f){this._change=f;}, appendChild(c){this._children.push(c);}, querySelectorAll(){return [];} }; }
global.document={ getElementById:id=>store[id]||(store[id]=makeEl()), createElement:()=>makeEl(), querySelectorAll:()=>[] };
store['strategy']=makeEl('both'); store['cdeRatePerp']=makeEl('initialMarginRate'); store['cdeRateFut']=makeEl('futuresRate'); store['hedgeVenue']=makeEl('cheapest');
eval(js);
console.log('render calls after init:', global.__getN());
store['strategy'].value='fut'; if(store['strategy']._change) store['strategy']._change();
console.log('render calls after fut toggle:', global.__getN(), '| tbody rows:', store['tbody']._children.length);
console.log('strategy.value seen by render:', store['strategy'].value);
console.log('tbody children length:', store['tbody']._children.length);
