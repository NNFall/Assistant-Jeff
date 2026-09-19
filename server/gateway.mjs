import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const port=Number(process.env.PORT || 18741);
const token=process.env.JEFF_GATEWAY_TOKEN;
const apiKey=process.env.GEMINI_API_KEY;
if(!token || !apiKey) throw new Error('Server credentials are not configured');
let active=0;
function authorized(req) {
  const given=Buffer.from(req.headers.authorization || '');
  const expected=Buffer.from(`Bearer ${token}`);
  return given.length===expected.length && timingSafeEqual(given,expected);
}
function reply(res,status,obj) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(obj)); }
const server=http.createServer(async(req,res)=>{
  if(!authorized(req)) return reply(res,401,{error:'Unauthorized'});
  if(req.method==='GET' && req.url==='/health') return reply(res,200,{ok:true,service:'assistant-jeff',model:process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'});
  if(req.method!=='POST'||req.url!=='/chat') return reply(res,404,{error:'Not found'});
  if(active>=2) return reply(res,429,{error:'Busy'});
  active++;
  const cancel=new AbortController();
  res.on('close',()=>{if(!res.writableEnded)cancel.abort();});
  try {
    const chunks=[]; let length=0;
    for await(const chunk of req){length+=chunk.length;if(length>16384){reply(res,413,{error:'Too large'});return;}chunks.push(chunk);}
    let body; try{body=JSON.parse(Buffer.concat(chunks));}catch{return reply(res,400,{error:'Invalid JSON'});}
    if(typeof body.text!=='string'||!body.text.trim()||body.text.length>4096) return reply(res,400,{error:'Invalid text'});
    const model=process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
    const upstream=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
      method:'POST',headers:{'content-type':'application/json','x-goog-api-key':apiKey},signal:AbortSignal.any([cancel.signal,AbortSignal.timeout(25000)]),
      body:JSON.stringify({contents:[{role:'user',parts:[{text:body.text}]}],systemInstruction:{parts:[{text:'Ты Jeff, личный помощник. Отвечай кратко и естественно по-русски. Ты отвечаешь только текстом. Не утверждай, что открыл программу, создал заметку, напоминание или выполнил действие: у тебя нет инструментов. Не придумывай актуальную погоду или результаты поиска.'}]},generationConfig:{maxOutputTokens:1024}})
    });
    if(!upstream.ok) return reply(res,502,{error:'Gemini unavailable',upstreamStatus:upstream.status});
    const data=await upstream.json(); const text=data.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text||'').join('').trim();
    if(!text) return reply(res,502,{error:'Empty response'});
    reply(res,200,{text,model,usage:data.usageMetadata});
  }catch{return reply(res,502,{error:'Provider request failed'});}finally{active--;}
});
server.requestTimeout=30000; server.headersTimeout=10000;
server.listen(port,'127.0.0.1',()=>console.log('Assistant Jeff gateway ready on loopback'));
