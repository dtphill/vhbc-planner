// Optional meeting choices only; no browser storage, BGG account or collection import.
const originalFetch=window.fetch.bind(window);
let data=null,busy=false,queued=false,testResult=null,feedback='';
const main=document.getElementById('main'),privateRoot=document.getElementById('private-planner-root');
const labels={'2':'2 players','3-4':'3–4 players','5+':'5+ players'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function schedule(){if(queued)return;queued=true;queueMicrotask(()=>{queued=false;decorate();});}
window.fetch=async(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);
  const response=await originalFetch(input,options);
  if(url.origin===location.origin&&response.ok){
    if(url.pathname==='/api/bootstrap'){try{data=await response.clone().json();schedule();}catch{}}
    if(['/api/admin/planner-test','/api/admin/planner-series'].includes(url.pathname)){
      try{testResult=await response.clone().json();queueMicrotask(renderTestSizes);}catch{}
    }
  }
  return response;
};
window.addEventListener('vhbc:data-updated',event=>{if(event.detail){data=event.detail;schedule();}});
function decorate(){
  const section=main?.querySelector('.mq-overview > section');if(!section||!data?.user)return;
  let box=section.querySelector('#meeting-size-choice');
  if(!data.attendance?.coming){box?.remove();return;}
  if(!box){box=document.createElement('div');box.id='meeting-size-choice';box.className='ms-choice';section.append(box);}
  const choice=data.tableSizeChoice,selected=choice?.preferences||[],disabled=busy||data.meeting?.status!=='open';
  const renderKey=JSON.stringify([data.user.id,data.meeting?.date,selected,disabled,busy,feedback]);
  if(box.dataset.renderKey===renderKey)return;box.dataset.renderKey=renderKey;
  const html='<p class="ms-label" id="ms-label">Table size this meeting <span>optional</span></p><div class="ms-options" role="group" aria-labelledby="ms-label">'+
    '<button type="button" data-ms-size="any" aria-pressed="'+!selected.length+'"'+(disabled?' disabled':'')+'>No preference</button>'+
    Object.entries(labels).map(([key,label])=>'<button type="button" data-ms-size="'+key+'" aria-pressed="'+selected.includes(key)+'"'+(disabled?' disabled':'')+'>'+label+'</button>').join('')+
    '</div><p class="ms-help">Select one or more. A preference, not a restriction. Applies only to this meeting.</p><p class="ms-feedback" role="status" aria-live="polite">'+(busy?'Saving…':feedback?esc(feedback):data.meeting?.status!=='open'?'Tables are confirmed. Ask the organiser about changes.':'')+'</p>';
  if(box.innerHTML!==html)box.innerHTML=html;
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-ms-size]');if(!button||busy||!data?.user)return;
  const snapshot=data,meetingDate=snapshot.meeting.date,key=button.dataset.msSize;
  const current=snapshot.tableSizeChoice?.preferences||[];
  let preferences=key==='any'?[]:current.includes(key)?current.filter(v=>v!==key):[...current,key];
  preferences=Object.keys(labels).filter(k=>preferences.includes(k));if(preferences.length===3)preferences=[];
  if(JSON.stringify(current)===JSON.stringify(preferences))return;
  feedback='';busy=true;decorate();
  try{
    const response=await originalFetch('/api/meeting-size-preferences',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({meetingDate,preferences})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Preference was not saved.');
    if(data.meeting?.date===meetingDate){data.tableSizeChoice={meetingDate,preferences:result.preferences,editable:true};if(result.changed)data.plan=null;}
    busy=false;decorate();
    window.dispatchEvent(new CustomEvent('vhbc:refresh',{detail:{message:'Table-size preference saved for this meeting.'}}));
  }catch(error){busy=false;feedback=error.message;decorate();document.querySelector('#meeting-size-choice .ms-feedback')?.setAttribute('role','alert');}
});
function renderTestSizes(){
  if(!privateRoot||!testResult)return;
  let panel=document.getElementById('ms-test-report');if(!panel){panel=document.createElement('details');panel.id='ms-test-report';panel.className='ms-test-report';privateRoot.append(panel);}
  const rounds=testResult.rounds||[testResult];
  panel.innerHTML='<summary>Table-size preferences in this test</summary><p class="ms-help">Matched sizes are considered after seating and eligible priorities, before game rotation. Preferences are date-specific; later dummy dates do not inherit this meeting’s choice.</p>'+rounds.map((r,index)=>{
    const rows=(r.tables||[]).flatMap(t=>(t.sizePreferences||[]).filter(p=>p.preferences.length).map(p=>({...p,name:(r.people||[]).find(m=>m.id===p.memberId)?.name||'Member'})));
    return '<h3>'+esc(testResult.rounds?'Dummy meeting '+(index+1):'Current meeting')+'</h3><p>'+Number(r.score?.tableSizeMatches||0)+' table-size preferences matched.</p>'+(rows.length?'<div class="ms-report-rows">'+rows.map(p=>'<p><strong>'+esc(p.name)+'</strong>: '+p.preferences.map(k=>esc(labels[k])).join(' or ')+' · seated at '+p.players+' · '+(p.matched?'matched':'other size needed')+'</p>').join('')+'</div>':'<p class="ms-help">No seated player has a size preference for this date.</p>');
  }).join('');
}
if(main)new MutationObserver(schedule).observe(main,{childList:true,subtree:true});
// Do not retain a previous report when either private test is cleared or restarted.
document.addEventListener('click',event=>{
  if(!privateRoot)return;const b=event.target.closest('button');if(!b)return;
  if(/clear simulation|run dummy|run private/i.test(b.textContent)){testResult=null;document.getElementById('ms-test-report')?.remove();}
});
schedule();
