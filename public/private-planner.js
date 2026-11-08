// This module never calls a live plan/confirmation/completion endpoint.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const root=document.getElementById('private-planner-root');
if (!root) {
  const main=document.getElementById('main');
  function attach() {
    if(!main || !document.querySelector('#navigation [data-view="organise"]') || main.querySelector('#ppt-launch'))return;
    const actions=main.querySelector('.admin-actions');
    if(!actions)return;
    const section=document.createElement('section');
    section.id='ppt-launch';section.className='ppt-launch';
    section.innerHTML='<div><h3>Private algorithm test</h3><p class="mq-muted">Try the current attendees without publishing tables or recording results.</p></div><a class="ppt-open" href="/admin/planner-test">Open private test</a>';
    actions.before(section);
  }
  if(main){new MutationObserver(attach).observe(main,{childList:true,subtree:true});attach();}
} else {
  const button=document.getElementById('ppt-run');
  const status=document.getElementById('ppt-status');
  const output=document.getElementById('ppt-results');
  function preference(person) {
    return person.priorityMet?'Priority pick':person.preference==='want'?'Want':person.preference==='will'?'Will play':'Unseated';
  }
  function draw(data) {
    if(data.private!==true || data.persisted!==false || !Array.isArray(data.tables))throw new Error('Unexpected test response. Nothing has been published.');
    const s=data.summary;
    const timestamp=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',hour:'numeric',minute:'2-digit',second:'2-digit'}).format(new Date(data.generatedAt));
    const warnings=data.warnings?.length?'<div class="ppt-warnings"><h3>Needs attention</h3><ul>'+data.warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></div>':'';
    const unseated=data.unassigned?.length?'<section class="ppt-unseated"><h3>Not seated in this test</h3><p>'+data.unassigned.map(p=>esc(p.name)).join(', ')+'</p><p class="mq-muted">Review the warnings, accepted games, exact player counts, teachers and available copies. No attendance or preferences have been changed.</p></section>':'';
    const tables=data.tables.map((t,index)=>'<article class="ppt-table"><p class="ppt-eyebrow">Test table '+(index+1)+(t.fixed?' · Existing reservation':' · Not published')+'</p><h3>'+esc(t.title)+'</h3><ul class="ppt-players">'+t.players.map(p=>'<li><span>'+esc(p.name)+'</span><span class="ppt-preference'+(p.priorityMet?' ppt-priority':'')+'">'+preference(p)+'</span></li>').join('')+'</ul><p class="mq-muted">Teaching: '+esc(t.teacherName)+'<br>Copy supplied by: '+esc(t.copyOwnerName)+'</p><p class="ppt-reason">'+esc(t.reason)+'</p></article>').join('');
    const details=data.people.map(p=>'<tr><th scope="row">'+esc(p.name)+'</th><td>'+esc(p.gameTitle||'Not seated')+'</td><td>'+preference(p)+(p.prearranged?' · Pre-arranged':'')+'</td><td>'+esc(p.priorityTitle||'None')+(p.priorityTitle?'<span class="ppt-priority-state">'+(p.priorityMet?'Selected':p.priorityFeasible?'A valid table was possible; not selected':'No valid priority table found')+'</span>':'')+'</td></tr>').join('');
    output.innerHTML='<section class="ppt-result-heading"><h2>'+esc(data.meeting.label)+'</h2><p class="mq-muted">Private snapshot at '+esc(timestamp)+' Melbourne time. Run again to include subsequent changes.</p></section>'+
      '<div class="ppt-scores"><div><strong>'+s.seated+' of '+s.attendees+'</strong><span>Attendees seated</span></div><div><strong>'+s.priorityMet+'</strong><span>Priority picks met</span></div><div><strong>'+s.want+' Want · '+s.will+' Will play</strong><span>Assigned preferences</span></div></div>'+
      warnings+unseated+(tables?'<div class="ppt-tables">'+tables+'</div>':'<p class="ppt-empty">'+(s.attendees?'No valid table could be formed from the current attendees and offers.':'Nobody is currently marked as coming. Mark attendance in the normal planner, then rerun this private test.')+'</p>')+
      '<details class="ppt-detail"><summary>Scoring and attendee details</summary><p>The live algorithm ranks seating first, then priority and fairness, then Want over Will play.</p><p><strong>Scores:</strong> seated '+data.score.seated+' · priority and fairness '+data.score.priorityAndFairness+' · preference '+data.score.desire+'. These are comparison scores, not probabilities.</p><p class="mq-muted">Existing reservations are respected ('+s.reservations+'). Their preference score is constant; they do not contribute priority/fairness points. Priority picks are included in the Want count.</p>'+
      (data.tieBreak?'<p class="mq-muted">Final tie-break: '+esc(data.tieBreak.method)+' · meeting '+esc(data.tieBreak.seed)+'. Unchanged inputs give the same result; rerunning does not redraw.</p>':'')+
      (details?'<div class="ppt-scroll"><table><thead><tr><th>Attendee</th><th>Test assignment</th><th>Preference</th><th>Current priority</th></tr></thead><tbody>'+details+'</tbody></table></div>':'')+
      '<p class="mq-muted">“A valid table was possible” does not mean it could coexist with every other table. This is a recommendation snapshot, not a record of games played.</p></details>'+
      '<p class="ppt-footnote">This result is only on this page. Closing or reloading the page discards it. The published meeting is unchanged.</p>';
  }
  button?.addEventListener('click',async()=>{
    if(button.disabled)return;
    button.disabled=true;output.innerHTML='';output.setAttribute('aria-busy','true');
    status.setAttribute('role','status');status.textContent='Reading current attendees and testing the allocation…';
    try {
      const response=await fetch('/api/admin/planner-test',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json','Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(30000)});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||'The private test could not run.');
      draw(data);status.textContent='Test complete. Nothing has been published, saved or recorded.';
      button.textContent='Run private test again';
    }catch(error){status.setAttribute('role','alert');status.textContent=error.name==='TimeoutError'?'The test timed out. No meeting data has been changed.':error.message||'The private test could not run. No meeting data has been changed.';}
    finally{button.disabled=false;output.setAttribute('aria-busy','false');}
  });
}
