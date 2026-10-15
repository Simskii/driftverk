import { useEffect, useState } from 'react';
import { api } from './api';
import { Link } from 'react-router-dom';

type Execution={id:string;command:string;status:string;exit_code:number|null;created_at:string;artifacts?:Array<{path:string;size:number|null;error:string|null}>};
type Chunk={sequence:string;stream:'stdout'|'stderr';data:string};
const terminal=new Set(['succeeded','failed','cancelled','timed_out','output_limit','lost']);
const statusLabel=(status:string)=>({succeeded:'Command exited successfully',failed:'Command failed',cancelled:'Cancelled',timed_out:'Time limit reached',output_limit:'Output limit reached',lost:'Execution interrupted'}[status] || status);

export function EnvironmentTasks({environmentId}:{environmentId:string}) {
  const [executions,setExecutions]=useState<Execution[]>([]);
  const [selected,setSelected]=useState('');
  const [detail,setDetail]=useState<Execution|null>(null);
  const [output,setOutput]=useState('');
  const [error,setError]=useState('');
  const [listError,setListError]=useState('');
  const [loading,setLoading]=useState(true);
  const [retry,setRetry]=useState(0);
  const [outputRetry,setOutputRetry]=useState(0);
  const [busy,setBusy]=useState(false);
  const base=`/api/environments/${encodeURIComponent(environmentId)}/tasks`;
  useEffect(()=>{
    let active=true;
    setLoading(true); setListError(''); setExecutions([]); setSelected('');
    const refresh=()=>api<{executions:Execution[]}>(base).then(value=>{if(active){setExecutions(value.executions);setSelected(current=>value.executions.some(item=>item.id===current) ? current : value.executions[0]?.id || '');setListError('');setLoading(false);}}).catch(()=>{if(active){setListError('Could not load command history.');setLoading(false);}});
    void refresh();const timer=setInterval(()=>void refresh(),5000);
    return()=>{active=false;clearInterval(timer);};
  },[base,retry]);
  useEffect(()=>{
    setDetail(null);setOutput('');setError('');
    if(!selected)return;
    let active=true,cursor='0';let timer:ReturnType<typeof setTimeout>;
    const decoders={stdout:new TextDecoder(),stderr:new TextDecoder()};
    const refresh=async()=>{
      try {
        const value=await api<{execution:Execution;output:Chunk[]}>(`${base}?execution=${encodeURIComponent(selected)}&after=${cursor}`);
        if(!active)return;
        setDetail(value.execution);
        let text='';
        for(const chunk of value.output){text+=decoders[chunk.stream].decode(Uint8Array.from(atob(chunk.data),c=>c.charCodeAt(0)),{stream:true});cursor=chunk.sequence;}
        if(value.output.length<100 && terminal.has(value.execution.status)) text+=decoders.stdout.decode()+decoders.stderr.decode();
        if(text)setOutput(previous=>(previous+text).slice(-2_097_152));
        if(value.output.length===100 || !terminal.has(value.execution.status)) timer=setTimeout(()=>void refresh(),value.output.length===100?0:2000);
      } catch {if(active)setError('Could not load command output.');}
    };
    void refresh();return()=>{active=false;clearTimeout(timer);};
  },[base,selected,outputRetry]);
  async function cancel(){setBusy(true);try{await api(`${base}?execution=${encodeURIComponent(selected)}`,{method:'POST',body:'{}'});}catch{setError('Could not cancel the task.');}finally{setBusy(false);}}
  return <div className="tasks-view">
    <p>Review saved command output, exit status and artifacts. Interactive agent conversations are not recorded here.</p>
    {loading && <p role="status">Loading command history…</p>}
    {listError && <div role="alert" className="form-alert form-alert-error">{listError} <button type="button" className="text-button" onClick={()=>setRetry(value=>value+1)}>Try again</button></div>}
    {error && <div role="alert" className="form-alert form-alert-error">{error} <button type="button" className="text-button" onClick={()=>setOutputRetry(value=>value+1)}>Reload output</button></div>}
    {!loading && !listError && !executions.length && <section className="results-empty"><h3>No saved command results yet</h3><p>Run a tracked command through the executions API to retain its output and collect small files such as test reports. Commands typed directly in the terminal do not appear here.</p><Link className="button button-secondary" to="/docs/api#execute-commands-and-reconnect">How to save command results</Link></section>}
    {executions.length > 0 && <label className="field"><span>Command results</span><select value={selected} onChange={event=>setSelected(event.target.value)}>{executions.map(item=><option key={item.id} value={item.id}>{new Date(item.created_at).toLocaleString()} · {statusLabel(item.status)} · {item.command.slice(0,100)}</option>)}</select></label>}
    {detail && <><p role="status">{statusLabel(detail.status)}{detail.exit_code!==null?` · Exit code ${detail.exit_code}`:''}</p>
      {!terminal.has(detail.status) && <button type="button" className="button button-secondary" disabled={busy} onClick={()=>void cancel()}>{busy?'Cancelling…':'Cancel command'}</button>}
      <pre className="task-output" aria-label="Command output">{output || 'No output captured.'}</pre>
      {detail.artifacts?.map(artifact=><p key={artifact.path}>{artifact.error?`${artifact.path}: ${artifact.error}`:<a href={`${base}?execution=${encodeURIComponent(selected)}&artifact=${encodeURIComponent(artifact.path)}`}>{artifact.path} ({artifact.size} bytes)</a>}</p>)}
    </>}
    {executions.length > 0 && <p className="subtle">A successful exit does not prove tests passed or the requested work is complete.</p>}
    <small>Up to 50 recent commands. Output is limited to 1 MiB per stream; each artifact to 128 KiB. Completed results become eligible for cleanup after seven days.</small>
  </div>;
}
