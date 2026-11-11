const fs=require('fs'), path=require('path'), os=require('os');
const esbuild=require('esbuild'); const {JSDOM}=require('jsdom');
const ROOT=path.resolve(__dirname,'..');
const BUNDLE=path.join(os.tmpdir(),'qp_num_'+Date.now()+'.cjs');
const dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true});
for(const k of ['window','document','DOMParser','Node','Element','HTMLElement','URL','Blob','MutationObserver','getComputedStyle']) global[k]=dom.window[k];
global.requestAnimationFrame=()=>0; global.cancelAnimationFrame=()=>{};
if(!dom.window.URL.createObjectURL) dom.window.URL.createObjectURL=()=>'blob:mock';
if(!dom.window.URL.revokeObjectURL) dom.window.URL.revokeObjectURL=()=>{};
(async()=>{
  const entry=path.join(ROOT,'src/renderer/lib/docxprobe.ts');
  fs.writeFileSync(entry,`export { renderAsync } from 'docx-preview';\n`,'utf-8');
  esbuild.buildSync({entryPoints:[entry],bundle:true,outfile:BUNDLE,format:'cjs',platform:'browser',mainFields:['browser','module','main'],logLevel:'error'});
  const {renderAsync}=require(BUNDLE);
  const file=process.argv[2];
  const buf=fs.readFileSync(file);
  const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
  const host=document.createElement('div'), styleHost=document.createElement('div');
  document.body.appendChild(host); document.body.appendChild(styleHost);
  await renderAsync(ab,host,styleHost,{className:'docx-preview',inWrapper:true,ignoreWidth:false,ignoreHeight:false,ignoreFonts:false,breakPages:true,ignoreLastRenderedPageBreak:true,renderHeaders:true,renderFooters:true,renderFootnotes:true,renderEndnotes:true,experimental:true,trimXmlDeclaration:true,debug:false});
  const styles=[...styleHost.querySelectorAll('style')].map(s=>s.textContent).join('\n');
  const numRules=styles.split(/\r?\n/).filter(l=>/num-|counter/.test(l));
  console.log('=== numbered css rules ('+numRules.length+') ===');
  console.log(numRules.slice(0,120).join('\n'));
  const ps=[...host.querySelectorAll('p')].filter(p=>/num-\d+-\d/.test(p.className));
  console.log('=== numbered paragraphs:',ps.length);
  for(const p of ps.slice(0,40)) console.log(' ',p.className,'|',(p.textContent||'').slice(0,40));
  // footer fields
  const foot=[...host.querySelectorAll('footer')];
  console.log('=== footers:',foot.length);
  if(foot[0]) console.log(foot[0].outerHTML.slice(0,1500));
  // emf images
  const imgs=[...host.querySelectorAll('img')].filter(i=>/emf|wmf/i.test(i.getAttribute('src')||''));
  console.log('=== emf imgs:',imgs.length, imgs.slice(0,2).map(i=>(i.getAttribute('src')||'').slice(0,60)));
  fs.writeFileSync(path.join(os.tmpdir(),'qp_style.css'),styles,'utf-8');
})().catch(e=>{console.error(e);process.exit(1);});
