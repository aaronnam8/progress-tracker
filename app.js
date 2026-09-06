// app.js — screen logic. Talks ONLY to `db` (see db.js). No direct window.claude calls here.
import { db } from './db.js';

(function(){
  "use strict";

  var CLASS_COLORS = ['#2F6E4F', '#2E5FA3', '#A34B2E', '#7A4FA3', '#A3862E', '#3C8B8B'];

  var state = {
    classes: [],
    students: [],
    sessions: [],
    selectedClassId: null,
    tab: 'record',
    selectedDate: todayStr(),
    historyStudentId: null,
    modalOpen: false,
    showArchived: false
  };
  var currentSessionData = null; // {id, classId, date, topic, memo, records:{}}

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function todayStr(d){
    d = d || new Date();
    var y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return y+'-'+m+'-'+day;
  }
  function shiftDate(dateStr, days){
    var parts = dateStr.split('-').map(Number);
    var d = new Date(parts[0], parts[1]-1, parts[2]);
    d.setDate(d.getDate()+days);
    return todayStr(d);
  }
  function formatKoreanDate(dateStr, opts){
    var parts = dateStr.split('-').map(Number);
    var d = new Date(parts[0], parts[1]-1, parts[2]);
    var week = ['일','월','화','수','목','금','토'];
    if(opts && opts.short) return parts[1]+'/'+parts[2];
    return parts[1]+'월 '+parts[2]+'일 ('+week[d.getDay()]+')';
  }
  function debounce(fn, ms){
    var t;
    return function(){
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function(){ fn.apply(null, args); }, ms);
    };
  }
  function understandingLabel(v){
    if(!v) return '미평가';
    if(v <= 2) return '하';
    if(v === 3) return '중';
    return '상';
  }

  function showToast(msg, isDanger){
    var root = document.getElementById('toastRoot');
    var el = document.createElement('div');
    el.className = 'toast' + (isDanger ? ' is-danger' : '');
    el.textContent = msg;
    root.appendChild(el);
    requestAnimationFrame(function(){ el.classList.add('is-show'); });
    setTimeout(function(){
      el.classList.remove('is-show');
      setTimeout(function(){ el.remove(); }, 250);
    }, 1800);
  }

  function activeClasses(){ return state.classes.filter(function(c){ return !c.archived; }); }
  function archivedClasses(){ return state.classes.filter(function(c){ return c.archived; }); }
  function getClass(id){ return state.classes.find(function(c){ return c.id === id; }); }
  function activeStudents(){ return state.students.filter(function(s){ return s.active !== false; }); }

  // ---------------- init / data loading ----------------
  function init(){
    db.ready.then(function(ok){
      if(!ok){ renderNoDb(); return; }
      refreshClasses();
    });
  }

  function renderNoDb(){
    document.getElementById('mainHeader').innerHTML = '';
    document.getElementById('tabNav').innerHTML = '';
    document.getElementById('tabContent').innerHTML =
      '<div class="empty-state"><h2>저장소를 불러올 수 없어요</h2>' +
      '<p>이 화면을 지원하는 뷰어에서 열면 기록이 자동으로 저장됩니다. 페이지를 다시 열어보세요.</p></div>';
  }

  function refreshClasses(){
    return db.classes.list().then(function(list){
      state.classes = list;
      if(!state.selectedClassId){
        var first = activeClasses()[0];
        if(first) return selectClass(first.id);
      } else if(!getClass(state.selectedClassId)){
        state.selectedClassId = null;
      }
      if(!state.modalOpen){
        renderSidebar();
        renderHeader();
        if(!state.selectedClassId) renderTabContentEmpty();
      }
    }).catch(function(err){ console.error('classes', err); });
  }

  function refreshStudents(classId){
    return db.students.listByClass(classId).then(function(list){
      state.students = list;
      if(!state.modalOpen){
        if(state.tab === 'record') loadSessionForDate();
        else render();
      }
    }).catch(function(err){ console.error('students', err); });
  }

  function refreshSessions(classId){
    return db.sessions.listByClass(classId).then(function(list){
      state.sessions = list;
      if(!state.modalOpen){
        if(state.tab === 'record') renderDateChips();
        if(state.tab === 'history') renderTabContent();
      }
    }).catch(function(err){ console.error('sessions', err); });
  }

  function selectClass(id){
    state.selectedClassId = id;
    state.selectedDate = todayStr();
    render();
    return Promise.all([refreshStudents(id), refreshSessions(id)]);
  }

  function loadSessionForDate(){
    if(!state.selectedClassId) return;
    var classId = state.selectedClassId, date = state.selectedDate;
    db.sessions.getByDate(classId, date).then(function(data){
      if(state.selectedClassId !== classId || state.selectedDate !== date) return; // stale response
      currentSessionData = { id: data.id, classId: classId, date: date, topic: data.topic || '', memo: data.memo || '', records: data.records || {} };
      if(state.tab === 'record') renderTabContent();
    }).catch(function(err){
      console.error('load session', err);
      currentSessionData = { id: null, classId: classId, date: date, topic: '', memo: '', records: {} };
      if(state.tab === 'record') renderTabContent();
    });
  }

  function changeDate(newDate){
    state.selectedDate = newDate;
    loadSessionForDate();
  }

  // ---------------- writes ----------------
  function updateLocalRecord(studentId, field, value){
    if(!currentSessionData) return;
    currentSessionData.records[studentId] = Object.assign({}, currentSessionData.records[studentId]);
    currentSessionData.records[studentId][field] = value;
  }

  function afterWrite(){
    // keep chips/history in sync without disturbing the roster the teacher is typing in
    if(state.selectedClassId) refreshSessions(state.selectedClassId);
  }

  function commitField(studentId, field, value){
    if(!currentSessionData) return;
    var payload = {}; payload[field] = value;
    db.records.upsert(currentSessionData.classId, currentSessionData.date, studentId, payload)
      .then(function(){ showToast('저장됨'); afterWrite(); })
      .catch(function(err){ console.error(err); showToast('저장 실패 · 다시 시도해 주세요', true); });
  }

  function commitSessionField(field, value){
    if(!currentSessionData) return;
    var payload = {}; payload[field] = value;
    db.sessions.update(currentSessionData.classId, currentSessionData.date, payload)
      .then(function(){ showToast('저장됨'); afterWrite(); })
      .catch(function(err){ console.error(err); showToast('저장 실패 · 다시 시도해 주세요', true); });
  }

  var debouncedTextSave = debounce(function(studentId, field, value){ commitField(studentId, field, value); }, 600);
  var debouncedSessionSave = debounce(function(field, value){ commitSessionField(field, value); }, 600);

  // ---------------- render: shell ----------------
  function render(){
    renderSidebar();
    renderHeader();
    renderTabNav();
    renderTabContent();
  }

  function renderSidebar(){
    var list = activeClasses();
    var html = list.map(function(c){
      var isActive = c.id === state.selectedClassId;
      return '<div class="class-row ' + (isActive?'is-active':'') + '" data-id="'+c.id+'">' +
        '<span class="class-dot" style="background:'+esc(c.color||CLASS_COLORS[0])+'"></span>' +
        '<div class="class-row-main">' +
          '<div class="class-row-name">'+esc(c.name)+'</div>' +
          '<div class="class-row-sub">'+esc(c.schedule||c.subject||'')+'</div>' +
        '</div>' +
        '<button class="class-edit-btn" data-edit="'+c.id+'" title="반 정보 수정">✎</button>' +
      '</div>';
    }).join('');
    if(!list.length){
      html = '<div style="padding:14px 8px; font-size:12.5px; color:var(--ink-soft);">아직 반이 없어요.<br>아래 버튼으로 첫 반을 만들어보세요.</div>';
    }
    document.getElementById('classList').innerHTML = html;
    var archived = archivedClasses();
    var toggleBtn = document.getElementById('archiveToggle');
    toggleBtn.textContent = archived.length ? ('보관함 ('+archived.length+')' + (state.showArchived ? ' 숨기기' : ' 보기')) : '';
    if(state.showArchived && archived.length){
      document.getElementById('classList').innerHTML += '<div style="height:6px"></div>' + archived.map(function(c){
        return '<div class="class-row" data-id="'+c.id+'" style="opacity:.6">' +
          '<span class="class-dot" style="background:'+esc(c.color||CLASS_COLORS[0])+'"></span>' +
          '<div class="class-row-main"><div class="class-row-name">'+esc(c.name)+' (보관됨)</div></div>' +
          '<button class="class-edit-btn" data-edit="'+c.id+'" title="반 정보 수정">✎</button>' +
        '</div>';
      }).join('');
    }
  }

  function renderHeader(){
    var header = document.getElementById('mainHeader');
    var cls = getClass(state.selectedClassId);
    if(!cls){
      header.innerHTML = '';
      document.getElementById('tabNav').innerHTML = '';
      return;
    }
    header.innerHTML =
      '<div class="class-title-row">' +
        '<div>' +
          '<div class="class-title"><span class="class-dot" style="background:'+esc(cls.color||CLASS_COLORS[0])+'"></span>'+esc(cls.name)+'</div>' +
          '<div class="class-subtitle">'+esc([cls.subject, cls.schedule].filter(Boolean).join(' · ') || '설명 없음')+' · 학생 '+activeStudents().length+'명</div>' +
        '</div>' +
      '</div>';
  }

  function renderTabNav(){
    var nav = document.getElementById('tabNav');
    if(!state.selectedClassId){ nav.innerHTML=''; return; }
    var tabs = [['record','진도 기록'],['students','학생 관리'],['history','히스토리']];
    nav.innerHTML = tabs.map(function(t){
      return '<button class="tab-btn '+(state.tab===t[0]?'is-active':'')+'" data-tab="'+t[0]+'">'+t[1]+'</button>';
    }).join('');
  }

  function renderTabContentEmpty(){
    document.getElementById('tabContent').innerHTML =
      '<div class="empty-state">' +
        '<h2>첫 반을 만들어보세요</h2>' +
        '<p>반을 만들고 학생을 등록하면, 매 수업마다 학생별 진도·이해도·숙제·메모를 몇 번의 클릭으로 기록할 수 있어요. 기록은 자동 저장되고 반별 히스토리로 언제든 다시 볼 수 있습니다.</p>' +
        '<button class="btn btn-primary" id="emptyAddClassBtn">+ 새 반 만들기</button>' +
      '</div>';
    var btn = document.getElementById('emptyAddClassBtn');
    if(btn) btn.addEventListener('click', function(){ openClassModal(); });
  }

  function renderTabContent(){
    if(!state.selectedClassId){ renderTabContentEmpty(); return; }
    if(state.tab === 'record') renderRecordTab();
    else if(state.tab === 'students') renderStudentsTab();
    else renderHistoryTab();
  }

  // ---------------- record tab ----------------
  function prevHomeworkFor(studentId){
    for(var i=0;i<state.sessions.length;i++){
      var s = state.sessions[i];
      if(s.date >= state.selectedDate) continue;
      var rec = (s.records||{})[studentId];
      if(rec && rec.homeworkAssigned){
        return formatKoreanDate(s.date, {short:true}) + ' · ' + rec.homeworkAssigned;
      }
    }
    return '';
  }

  function chipStatus(session){
    var total = activeStudents().length || 1;
    var count = Object.keys(session.records || {}).filter(function(sid){
      var r = session.records[sid];
      return r && (r.progress || r.understanding || r.homeworkAssigned || r.note);
    }).length;
    if(count === 0) return 'empty';
    if(count >= total) return 'full';
    return 'partial';
  }

  function renderDateChips(){
    var wrap = document.getElementById('dateChips');
    if(!wrap) return;
    var sorted = state.sessions.slice().sort(function(a,b){ return a.date < b.date ? 1 : -1; }).slice(0, 30);
    wrap.innerHTML = sorted.map(function(s){
      return '<button class="chip '+(s.date===state.selectedDate?'is-active':'')+'" data-jump="'+s.date+'">' +
        '<span class="chip-dot '+chipStatus(s)+'"></span>' + formatKoreanDate(s.date,{short:true}) +
      '</button>';
    }).join('') || '<span style="font-size:11.5px; color:var(--ink-faint);">아직 기록된 수업이 없어요.</span>';
  }

  function renderRecordTab(){
    if(!currentSessionData){ loadSessionForDate(); return; }
    var students = activeStudents();
    var filled = students.filter(function(s){
      var r = currentSessionData.records[s.id];
      return r && (r.progress || r.understanding || r.homeworkAssigned || r.note);
    }).length;
    var pillFull = students.length > 0 && filled === students.length;

    var rowsHtml = students.map(function(s){
      var rec = currentSessionData.records[s.id] || {};
      var stars = '';
      for(var i=1;i<=5;i++){
        stars += '<button type="button" class="star '+(rec.understanding>=i?'is-on':'')+'" data-val="'+i+'" data-student="'+s.id+'" aria-label="'+i+'점">★</button>';
      }
      var prevHw = prevHomeworkFor(s.id);
      return '<tr>' +
        '<td class="name-cell">'+esc(s.name)+(s.phone?'<span class="stu-phone">'+esc(s.phone)+'</span>':'')+'</td>' +
        '<td class="col-progress"><input type="text" class="cell-input" data-student="'+s.id+'" data-field="progress" placeholder="예: 3단원 p.44~52" value="'+esc(rec.progress||'')+'"></td>' +
        '<td><div class="stars" data-student="'+s.id+'">'+stars+'</div><div class="stars-label">'+understandingLabel(rec.understanding)+'</div></td>' +
        '<td class="hw-block">' +
          '<label class="check"><input type="checkbox" data-student="'+s.id+'" data-field="homeworkDone" '+(rec.homeworkDone?'checked':'')+'><span>지난 숙제 완료</span></label>' +
          '<div class="hw-prev-text" title="'+esc(prevHw||'이전 숙제 없음')+'">'+esc(prevHw || '이전 숙제 없음')+'</div>' +
          '<input type="text" class="cell-input hw-new" data-student="'+s.id+'" data-field="homeworkAssigned" placeholder="오늘 낸 숙제" value="'+esc(rec.homeworkAssigned||'')+'">' +
        '</td>' +
        '<td class="col-note"><input type="text" class="cell-input" data-student="'+s.id+'" data-field="note" placeholder="특이사항" value="'+esc(rec.note||'')+'"></td>' +
      '</tr>';
    }).join('');

    if(!students.length){
      rowsHtml = '<tr><td colspan="5" style="text-align:center; color:var(--ink-soft); padding:30px;">이 반에 등록된 학생이 없어요. "학생 관리" 탭에서 추가해 주세요.</td></tr>';
    }

    document.getElementById('tabContent').innerHTML =
      '<div class="record-toolbar">' +
        '<div class="date-nav">' +
          '<button class="step" id="prevDay" title="전날">‹</button>' +
          '<input type="date" id="datePicker" value="'+state.selectedDate+'">' +
          '<button class="step" id="nextDay" title="다음날">›</button>' +
          '<button class="btn btn-sm" id="todayBtn">오늘</button>' +
          '<span class="date-label">'+formatKoreanDate(state.selectedDate)+'</span>' +
        '</div>' +
        '<div class="progress-pill '+(pillFull?'is-full':'')+'">'+filled+' / '+students.length+'명 기록</div>' +
      '</div>' +
      '<div class="session-meta">' +
        '<input type="text" id="topicInput" class="topic-input" placeholder="오늘 수업 주제 (예: 3단원 이차방정식)" value="'+esc(currentSessionData.topic||'')+'">' +
        '<input type="text" id="memoInput" class="session-memo-input" placeholder="수업 전체 메모 (선택)" value="'+esc(currentSessionData.memo||'')+'">' +
      '</div>' +
      '<div class="date-chips" id="dateChips"></div>' +
      '<div class="roster-scroll"><table class="roster">' +
        '<thead><tr><th style="width:120px">이름</th><th>진도 범위</th><th style="width:110px">이해도</th><th style="width:210px">숙제</th><th>메모</th></tr></thead>' +
        '<tbody id="rosterBody">'+rowsHtml+'</tbody>' +
      '</table></div>';

    renderDateChips();
    wireRecordEvents();
  }

  function wireRecordEvents(){
    document.getElementById('prevDay').addEventListener('click', function(){ changeDate(shiftDate(state.selectedDate,-1)); });
    document.getElementById('nextDay').addEventListener('click', function(){ changeDate(shiftDate(state.selectedDate,1)); });
    document.getElementById('todayBtn').addEventListener('click', function(){ changeDate(todayStr()); });
    document.getElementById('datePicker').addEventListener('change', function(e){ if(e.target.value) changeDate(e.target.value); });
    document.getElementById('topicInput').addEventListener('input', function(e){
      currentSessionData.topic = e.target.value;
      debouncedSessionSave('topic', e.target.value);
    });
    document.getElementById('memoInput').addEventListener('input', function(e){
      currentSessionData.memo = e.target.value;
      debouncedSessionSave('memo', e.target.value);
    });
    document.getElementById('dateChips').addEventListener('click', function(e){
      var chip = e.target.closest('[data-jump]');
      if(chip) changeDate(chip.getAttribute('data-jump'));
    });

    var roster = document.getElementById('rosterBody');
    roster.addEventListener('input', function(e){
      var t = e.target;
      if(t.matches('input.cell-input')){
        var studentId = t.dataset.student, field = t.dataset.field;
        updateLocalRecord(studentId, field, t.value);
        debouncedTextSave(studentId, field, t.value);
      }
    });
    roster.addEventListener('change', function(e){
      var t = e.target;
      if(t.matches('input[type=checkbox][data-field=homeworkDone]')){
        var studentId = t.dataset.student;
        updateLocalRecord(studentId, 'homeworkDone', t.checked);
        commitField(studentId, 'homeworkDone', t.checked);
      }
    });
    roster.addEventListener('click', function(e){
      var star = e.target.closest('.star');
      if(!star) return;
      var studentId = star.dataset.student;
      var val = Number(star.dataset.val);
      var wrap = star.closest('.stars');
      Array.prototype.forEach.call(wrap.querySelectorAll('.star'), function(st){
        st.classList.toggle('is-on', Number(st.dataset.val) <= val);
      });
      wrap.parentElement.querySelector('.stars-label').textContent = understandingLabel(val);
      updateLocalRecord(studentId, 'understanding', val);
      commitField(studentId, 'understanding', val);
    });
  }

  // ---------------- students tab ----------------
  function renderStudentsTab(){
    var students = state.students.slice().sort(function(a,b){
      if((a.active!==false) !== (b.active!==false)) return a.active===false ? 1 : -1;
      return (a.name||'').localeCompare(b.name||'','ko');
    });
    var rows = students.map(function(s){
      var isActive = s.active !== false;
      return '<tr class="'+(isActive?'':'is-inactive')+'">' +
        '<td>'+esc(s.name)+'</td>' +
        '<td class="mono">'+esc(s.phone||'-')+'</td>' +
        '<td class="mono">'+esc(s.parentPhone||'-')+'</td>' +
        '<td><span class="badge '+(isActive?'active':'inactive')+'">'+(isActive?'활성':'비활성')+'</span></td>' +
        '<td style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">'+esc(s.note||'')+'</td>' +
        '<td><div class="row-actions"><button data-edit-student="'+s.id+'">수정</button><button data-toggle-student="'+s.id+'">'+(isActive?'비활성화':'활성화')+'</button></div></td>' +
      '</tr>';
    }).join('');
    document.getElementById('tabContent').innerHTML =
      '<div class="students-toolbar">' +
        '<div class="count">전체 '+students.length+'명 · 활성 '+students.filter(function(s){return s.active!==false;}).length+'명</div>' +
        '<button class="btn btn-primary" id="addStudentBtn">+ 학생 추가</button>' +
      '</div>' +
      (students.length ?
        '<table class="students"><thead><tr><th>이름</th><th>연락처</th><th>학부모 연락처</th><th>상태</th><th>메모</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>'
        : '<div class="empty-state"><h2>학생을 등록해 주세요</h2><p>학생을 추가하면 진도 기록 탭의 출석부에 자동으로 나타나요.</p></div>');

    var addBtn = document.getElementById('addStudentBtn');
    if(addBtn) addBtn.addEventListener('click', function(){ openStudentModal(); });
    document.querySelectorAll('[data-edit-student]').forEach(function(btn){
      btn.addEventListener('click', function(){ openStudentModal(btn.getAttribute('data-edit-student')); });
    });
    document.querySelectorAll('[data-toggle-student]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-toggle-student');
        var s = state.students.find(function(x){ return x.id===id; });
        db.students.setStatus(id, s.active===false).then(function(){
          showToast(s.active===false ? '활성화했어요' : '비활성화했어요');
          refreshStudents(state.selectedClassId);
        }).catch(function(){ showToast('처리 실패', true); });
      });
    });
  }

  function openStudentModal(studentId){
    var editing = studentId ? state.students.find(function(s){ return s.id===studentId; }) : null;
    state.modalOpen = true;
    document.getElementById('modalRoot').innerHTML =
      '<div class="modal-backdrop" id="modalBackdrop"><div class="modal">' +
        '<h3>'+(editing?'학생 정보 수정':'학생 추가')+'</h3>' +
        '<div class="field"><label>이름 *</label><input type="text" id="mStuName" value="'+esc(editing?editing.name:'')+'" placeholder="예: 김민준"></div>' +
        '<div class="field"><label>연락처</label><input type="text" id="mStuPhone" value="'+esc(editing?editing.phone:'')+'" placeholder="010-0000-0000"></div>' +
        '<div class="field"><label>학부모 연락처</label><input type="text" id="mStuParent" value="'+esc(editing?editing.parentPhone:'')+'" placeholder="010-0000-0000"></div>' +
        '<div class="field"><label>메모</label><textarea id="mStuNote" rows="2" placeholder="특이사항 (선택)">'+esc(editing?editing.note:'')+'</textarea></div>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost" id="mCancel">취소</button>' +
          '<div class="modal-actions-right"><button class="btn btn-primary" id="mSave">저장</button></div>' +
        '</div>' +
      '</div></div>';
    document.getElementById('mCancel').addEventListener('click', closeModal);
    document.getElementById('modalBackdrop').addEventListener('click', function(e){ if(e.target.id==='modalBackdrop') closeModal(); });
    document.getElementById('mSave').addEventListener('click', function(){
      var name = document.getElementById('mStuName').value.trim();
      if(!name){ showToast('이름을 입력해 주세요', true); return; }
      var data = {
        name: name,
        phone: document.getElementById('mStuPhone').value.trim(),
        parentPhone: document.getElementById('mStuParent').value.trim(),
        note: document.getElementById('mStuNote').value.trim(),
        classId: state.selectedClassId
      };
      var p = editing ? db.students.update(editing.id, data) : db.students.create(data);
      p.then(function(){ showToast('저장됨'); closeModal(); refreshStudents(state.selectedClassId); })
       .catch(function(){ showToast('저장 실패', true); });
    });
  }

  function closeModal(){
    state.modalOpen = false;
    document.getElementById('modalRoot').innerHTML = '';
    render();
  }

  // ---------------- class modal ----------------
  function openClassModal(classId){
    var editing = classId ? getClass(classId) : null;
    state.modalOpen = true;
    var color = editing ? (editing.color||CLASS_COLORS[0]) : CLASS_COLORS[activeClasses().length % CLASS_COLORS.length];
    document.getElementById('modalRoot').innerHTML =
      '<div class="modal-backdrop" id="modalBackdrop"><div class="modal">' +
        '<h3>'+(editing?'반 정보 수정':'새 반 만들기')+'</h3>' +
        '<div class="field"><label>반 이름 *</label><input type="text" id="mClsName" value="'+esc(editing?editing.name:'')+'" placeholder="예: 중2 수학 B반"></div>' +
        '<div class="field"><label>과목/설명</label><input type="text" id="mClsSubject" value="'+esc(editing?editing.subject:'')+'" placeholder="예: 중등 수학"></div>' +
        '<div class="field"><label>요일·시간</label><input type="text" id="mClsSchedule" value="'+esc(editing?editing.schedule:'')+'" placeholder="예: 월·수·금 16:00"></div>' +
        '<div class="field"><label>색상</label><div class="swatches" id="mClsSwatches">' +
          CLASS_COLORS.map(function(c){ return '<div class="swatch '+(c===color?'is-selected':'')+'" data-color="'+c+'" style="background:'+c+'"></div>'; }).join('') +
        '</div></div>' +
        '<div class="modal-actions">' +
          '<div>'+(editing?'<button class="btn-danger-text" id="mArchive">'+(editing.archived?'보관 해제':'반 보관하기')+'</button>':'<button class="btn btn-ghost" id="mCancel">취소</button>')+'</div>' +
          '<div class="modal-actions-right">'+(editing?'<button class="btn btn-ghost" id="mCancel2">취소</button>':'')+'<button class="btn btn-primary" id="mSave">저장</button></div>' +
        '</div>' +
      '</div></div>';
    var selectedColor = color;
    document.getElementById('mClsSwatches').addEventListener('click', function(e){
      var sw = e.target.closest('.swatch');
      if(!sw) return;
      selectedColor = sw.getAttribute('data-color');
      document.querySelectorAll('#mClsSwatches .swatch').forEach(function(s2){ s2.classList.toggle('is-selected', s2===sw); });
    });
    var cancelBtn = document.getElementById('mCancel') || document.getElementById('mCancel2');
    if(cancelBtn) cancelBtn.addEventListener('click', closeModal);
    var cancel2 = document.getElementById('mCancel2');
    if(cancel2) cancel2.addEventListener('click', closeModal);
    document.getElementById('modalBackdrop').addEventListener('click', function(e){ if(e.target.id==='modalBackdrop') closeModal(); });
    if(editing){
      document.getElementById('mArchive').addEventListener('click', function(){
        db.classes.archive(editing.id, !editing.archived).then(function(){
          showToast(editing.archived ? '보관 해제했어요' : '보관함으로 이동했어요');
          if(!editing.archived && state.selectedClassId === editing.id) state.selectedClassId = null;
          closeModal();
          refreshClasses();
        }).catch(function(){ showToast('처리 실패', true); });
      });
    }
    document.getElementById('mSave').addEventListener('click', function(){
      var name = document.getElementById('mClsName').value.trim();
      if(!name){ showToast('반 이름을 입력해 주세요', true); return; }
      var data = {
        name: name,
        subject: document.getElementById('mClsSubject').value.trim(),
        schedule: document.getElementById('mClsSchedule').value.trim(),
        color: selectedColor
      };
      var p = editing ? db.classes.update(editing.id, data) : db.classes.create(data);
      p.then(function(ref){
        showToast('저장됨');
        closeModal();
        if(!editing && ref && ref.id){
          refreshClasses().then(function(){ selectClass(ref.id); });
        } else {
          refreshClasses();
        }
      }).catch(function(){ showToast('저장 실패', true); });
    });
  }

  // ---------------- history tab ----------------
  function renderHistoryTab(){
    var students = state.students.slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||'','ko'); });
    if(!students.length){
      document.getElementById('tabContent').innerHTML = '<div class="empty-state"><h2>학생을 먼저 등록해 주세요</h2><p>학생을 추가하면 이 곳에서 개인별 진도 히스토리를 볼 수 있어요.</p></div>';
      return;
    }
    if(!state.historyStudentId || !students.find(function(s){return s.id===state.historyStudentId;})){
      state.historyStudentId = students[0].id;
    }
    var sid = state.historyStudentId;
    var entries = state.sessions.filter(function(s){ return s.records && s.records[sid]; })
      .map(function(s){ return {date:s.date, topic:s.topic, rec: s.records[sid]}; })
      .sort(function(a,b){ return a.date < b.date ? 1 : -1; });

    var totalSessions = entries.length;
    var understandingVals = entries.filter(function(e){ return e.rec.understanding; }).map(function(e){ return e.rec.understanding; });
    var avgUnderstanding = understandingVals.length ? (understandingVals.reduce(function(a,b){return a+b;},0)/understandingVals.length) : 0;
    var hwTracked = entries.filter(function(e){ return e.rec.homeworkDone !== undefined; });
    var hwDone = hwTracked.filter(function(e){ return e.rec.homeworkDone; }).length;
    var hwRate = hwTracked.length ? Math.round(hwDone/hwTracked.length*100) : null;

    var timelineHtml = entries.map(function(e){
      var starsRo = '';
      for(var i=1;i<=5;i++) starsRo += '<span class="star readonly '+(e.rec.understanding>=i?'is-on':'')+'">★</span>';
      return '<div class="timeline-item">' +
        '<div class="tl-date">'+formatKoreanDate(e.date,{short:true})+'</div>' +
        '<div class="tl-body">' +
          (e.topic ? '<div class="tl-topic">'+esc(e.topic)+'</div>' : '') +
          '<div class="tl-progress">'+esc(e.rec.progress || '진도 기록 없음')+'</div>' +
          '<div class="tl-row">' +
            '<span>'+starsRo+' '+understandingLabel(e.rec.understanding)+'</span>' +
            (e.rec.homeworkAssigned ? '<span class="hw-badge '+(e.rec.homeworkDone?'done':'undone')+'">'+(e.rec.homeworkDone?'숙제 완료':'숙제 미완료')+'</span>' : '') +
          '</div>' +
          (e.rec.homeworkAssigned ? '<div class="tl-note">숙제: '+esc(e.rec.homeworkAssigned)+'</div>' : '') +
          (e.rec.note ? '<div class="tl-note">메모: '+esc(e.rec.note)+'</div>' : '') +
        '</div>' +
      '</div>';
    }).join('') || '<div class="empty-state" style="padding:30px 0;"><p>이 학생의 기록이 아직 없어요.</p></div>';

    document.getElementById('tabContent').innerHTML =
      '<div class="history-picker">' +
        '<select id="historySelect">' + students.map(function(s){ return '<option value="'+s.id+'" '+(s.id===sid?'selected':'')+'>'+esc(s.name)+(s.active===false?' (비활성)':'')+'</option>'; }).join('') + '</select>' +
      '</div>' +
      '<div class="stat-row">' +
        '<div class="stat-tile"><div class="num mono">'+totalSessions+'</div><div class="lbl">기록된 수업 수</div></div>' +
        '<div class="stat-tile"><div class="num mono">'+(avgUnderstanding?avgUnderstanding.toFixed(1):'-')+'</div><div class="lbl">평균 이해도 (5점)</div></div>' +
        '<div class="stat-tile"><div class="num mono">'+(hwRate!==null?hwRate+'%':'-')+'</div><div class="lbl">숙제 완료율</div></div>' +
      '</div>' +
      '<div class="timeline">'+timelineHtml+'</div>';

    document.getElementById('historySelect').addEventListener('change', function(e){
      state.historyStudentId = e.target.value;
      renderHistoryTab();
    });
  }

  // ---------------- global event wiring (static shell) ----------------
  document.getElementById('classList').addEventListener('click', function(e){
    var editBtn = e.target.closest('[data-edit]');
    if(editBtn){ openClassModal(editBtn.getAttribute('data-edit')); return; }
    var row = e.target.closest('.class-row');
    if(row) selectClass(row.getAttribute('data-id'));
  });
  document.getElementById('addClassBtn').addEventListener('click', function(){ openClassModal(); });
  document.getElementById('archiveToggle').addEventListener('click', function(){
    state.showArchived = !state.showArchived;
    renderSidebar();
  });
  document.getElementById('tabNav').addEventListener('click', function(e){
    var btn = e.target.closest('[data-tab]');
    if(!btn) return;
    state.tab = btn.getAttribute('data-tab');
    renderTabNav();
    if(state.tab === 'record') loadSessionForDate();
    else renderTabContent();
  });

  init();
})();
