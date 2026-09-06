// app.js — screen logic. Talks ONLY to `db` (see db.js). No direct storage calls here.
import { db } from './db.js';

(function(){
  "use strict";

  var CLASS_COLORS = ['#2F6E4F', '#2E5FA3', '#A34B2E', '#7A4FA3', '#A3862E', '#3C8B8B'];
  var ATT_CYCLE = ['present', 'late', 'absent', 'makeup'];
  var ATT_LABEL = { present: '출석', late: '지각', absent: '결석', makeup: '보강' };
  var STATUS_LABEL = { active: '활성', paused: '휴학', left: '퇴원' };

  var state = {
    classes: [],
    students: [],        // students enrolled in the selected class (any status)
    sessions: [],         // all sessions for the selected class
    classRecords: [],     // all record rows for the selected class's sessions (date-joined)
    classAttendance: [],  // all attendance rows for the selected class's sessions (date-joined)
    selectedClassId: null,
    selectedStudentId: null, // null = whole-class mode
    tab: 'record',           // 'record' | 'history' | 'report'
    selectedDate: todayStr(),
    historyStudentId: null,  // dropdown fallback when no sidebar student is selected
    historyPeriod: '1m',     // '1m' | '3m' | 'all' | 'custom'
    historyFrom: '', historyTo: '',
    handoff: false,
    reportStudentId: null,
    reportFrom: monthsAgoStr(1), reportTo: todayStr(),
    reportDraft: '', reportSavedId: null, reportList: [],
    modalOpen: false,
    showArchived: false
  };
  var currentSession = null;     // {id, classId, date, topic, materialRef}
  var currentAttendance = {};    // studentId -> status (effective, defaults to 'present')
  var currentRecords = {};      // studentId -> record fields
  var lastHwToday = '';

  // ---------------- helpers ----------------
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
  function monthsAgoStr(n){
    var d = new Date();
    d.setMonth(d.getMonth() - n);
    return todayStr(d);
  }
  function formatKoreanDate(dateStr, opts){
    var parts = dateStr.split('-').map(Number);
    var d = new Date(parts[0], parts[1]-1, parts[2]);
    var week = ['일','월','화','수','목','금','토'];
    if(opts && opts.short) return parts[1]+'/'+parts[2];
    return parts[1]+'월 '+parts[2]+'일 ('+week[d.getDay()]+')';
  }
  function dateInRange(d, from, to){
    if(from && d < from) return false;
    if(to && d > to) return false;
    return true;
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
  function maskPhone(p){
    if(!p) return '';
    var digits = p.replace(/[^0-9]/g, '');
    if(digits.length < 7) return p;
    return p.replace(/(\d{2,3}-?\d{3,4}-?)(\d{4})/, function(m, a, b){ return a.replace(/\d/g,'*') + b.slice(-4); });
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
  function activeStudents(){ return state.students.filter(function(s){ return (s.status||'active') === 'active'; }); }
  function getStudent(id){ return state.students.find(function(s){ return s.id === id; }); }

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
      '<p>이 브라우저에서 로컬 저장(localStorage)을 지원하지 않는 것 같아요.</p></div>';
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

  function refreshClassData(classId){
    return Promise.all([
      db.students.listByClass(classId),
      db.sessions.listByClass(classId),
      db.records.listByClass(classId),
      db.attendance.listByClass(classId)
    ]).then(function(res){
      state.students = res[0];
      state.sessions = res[1];
      state.classRecords = res[2];
      state.classAttendance = res[3];
      if(!state.modalOpen){
        renderSidebar();
        renderHeader();
        if(state.tab === 'record') loadSessionForDate();
        else renderTabContent();
      }
    }).catch(function(err){ console.error('class data', err); });
  }

  // lighter refresh after a write: keeps chips/history/prev-lookups in sync
  // without re-rendering the roster the teacher may be typing in.
  function refreshClassDataLight(){
    if(!state.selectedClassId) return Promise.resolve();
    return Promise.all([
      db.sessions.listByClass(state.selectedClassId),
      db.records.listByClass(state.selectedClassId),
      db.attendance.listByClass(state.selectedClassId)
    ]).then(function(res){
      state.sessions = res[0]; state.classRecords = res[1]; state.classAttendance = res[2];
      if(state.tab === 'record') renderDateChips();
      if(state.tab === 'history') renderTabContent();
    });
  }

  function selectClass(id){
    state.selectedClassId = id;
    state.selectedStudentId = null;
    state.selectedDate = todayStr();
    render();
    return refreshClassData(id);
  }

  function selectStudent(id){
    state.selectedStudentId = id;
    state.tab = 'record';
    render();
  }

  function backToWholeClass(){
    state.selectedStudentId = null;
    render();
  }

  // effective date shown by the record tab: whole-class mode uses the date-nav;
  // individual mode jumps straight to that student's most recent session.
  function effectiveRecordDate(){
    if(!state.selectedStudentId) return state.selectedDate;
    var mine = state.classRecords.filter(function(r){ return r.studentId === state.selectedStudentId; })
      .sort(function(a,b){ return a.date < b.date ? 1 : -1; });
    return mine.length ? mine[0].date : todayStr();
  }

  function loadSessionForDate(){
    if(!state.selectedClassId) return;
    var classId = state.selectedClassId, date = effectiveRecordDate();
    var existing = state.sessions.find(function(s){ return s.date === date; });
    currentSession = existing
      ? Object.assign({}, existing)
      : { id: null, classId: classId, date: date, topic: '', materialRef: '' };

    currentAttendance = {};
    currentRecords = {};
    if(currentSession.id){
      state.classAttendance.filter(function(a){ return a.sessionId === currentSession.id; })
        .forEach(function(a){ currentAttendance[a.studentId] = a.status; });
      state.classRecords.filter(function(r){ return r.sessionId === currentSession.id; })
        .forEach(function(r){ currentRecords[r.studentId] = r; });
    }
    if(state.tab === 'record') renderTabContent();
  }

  function changeDate(newDate){
    state.selectedDate = newDate;
    loadSessionForDate();
  }

  // ---------------- writes ----------------
  function ensureSessionId(){
    if(currentSession.id) return Promise.resolve(currentSession.id);
    return db.sessions.create(currentSession.classId, currentSession.date, {
      topic: currentSession.topic || '', materialRef: currentSession.materialRef || ''
    }).then(function(res){
      currentSession.id = res.id;
      state.sessions.push(Object.assign({ id: res.id, createdAt: new Date().toISOString() }, currentSession));
      return res.id;
    });
  }

  function commitSessionField(field, value){
    currentSession[field] = value;
    var wasNew = !currentSession.id;
    ensureSessionId().then(function(id){
      if(!wasNew){
        var payload = {}; payload[field] = value;
        return db.sessions.update(id, payload);
      }
    }).then(function(){ showToast('저장됨'); refreshClassDataLight(); })
      .catch(function(err){ console.error(err); showToast('저장 실패 · 다시 시도해 주세요', true); });
  }

  function updateLocalRecord(studentId, field, value){
    currentRecords[studentId] = Object.assign({}, currentRecords[studentId]);
    currentRecords[studentId][field] = value;
  }

  function commitRecordField(studentId, field, value){
    ensureSessionId().then(function(id){
      var payload = {}; payload[field] = value;
      return db.records.upsert(id, studentId, payload);
    }).then(function(){ showToast('저장됨'); refreshClassDataLight(); })
      .catch(function(err){ console.error(err); showToast('저장 실패 · 다시 시도해 주세요', true); });
  }

  function setAttendance(studentId, status){
    currentAttendance[studentId] = status;
    renderTabContent();
    ensureSessionId().then(function(id){
      return db.attendance.upsertMany(id, [{ studentId: studentId, status: status }]);
    }).then(function(){ refreshClassDataLight(); })
      .catch(function(err){ console.error(err); showToast('출결 저장 실패', true); });
  }

  function cycleAttendance(studentId){
    var cur = currentAttendance[studentId] || 'present';
    var next = ATT_CYCLE[(ATT_CYCLE.indexOf(cur) + 1) % ATT_CYCLE.length];
    setAttendance(studentId, next);
  }

  var debouncedRecordSave = debounce(function(studentId, field, value){ commitRecordField(studentId, field, value); }, 800);
  var debouncedSessionSave = debounce(function(field, value){ commitSessionField(field, value); }, 800);

  // Shows/hides the "숙제 전체 적용" button live as hwToday fields are typed into,
  // without a full re-render of the roster (which would steal input focus).
  function applyHwToAll(){
    if(!lastHwToday) return;
    activeStudents().forEach(function(s){
      var status = currentAttendance[s.id] || 'present';
      if(status === 'absent' || status === 'makeup') return;
      updateLocalRecord(s.id, 'hwToday', lastHwToday);
      commitRecordField(s.id, 'hwToday', lastHwToday);
    });
    renderTabContent();
    showToast('전체 적용했어요');
  }
  function wireApplyHwButton(){
    var btn = document.getElementById('applyHwAllBtn');
    if(btn) btn.addEventListener('click', applyHwToAll);
  }
  function updateApplyHwButtonVisibility(){
    var meta = document.querySelector('.session-meta');
    if(!meta) return;
    var anyHw = Object.keys(currentRecords).some(function(sid){ return currentRecords[sid] && currentRecords[sid].hwToday; });
    var btn = document.getElementById('applyHwAllBtn');
    if(anyHw && !btn){
      btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn btn-sm'; btn.id = 'applyHwAllBtn'; btn.textContent = '숙제 전체 적용';
      btn.addEventListener('click', applyHwToAll);
      meta.appendChild(btn);
    } else if(!anyHw && btn){
      btn.remove();
    }
  }

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
      var row = '<div class="class-row ' + (isActive?'is-active':'') + '" data-id="'+c.id+'">' +
        '<span class="class-dot" style="background:'+esc(c.color||CLASS_COLORS[0])+'"></span>' +
        '<div class="class-row-main">' +
          '<div class="class-row-name">'+esc(c.name)+'</div>' +
          '<div class="class-row-sub">'+esc(c.schedule||c.subject||'')+'</div>' +
        '</div>' +
        '<button class="class-edit-btn" data-edit="'+c.id+'" title="반 정보 수정">✎</button>' +
      '</div>';
      if(isActive){
        var students = state.students.slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||'','ko'); });
        row += '<div class="sub-student-list">';
        if(state.selectedStudentId){
          row += '<button class="sub-back-btn" data-back-whole>‹ 반 전체 보기</button>';
        }
        row += students.map(function(s){
          var isS = s.id === state.selectedStudentId;
          var st = s.status || 'active';
          return '<div class="sub-student-row '+(isS?'is-active':'')+(st!=='active'?' is-dim':'')+'" data-student="'+s.id+'">' +
            '<span class="sub-student-name">'+esc(s.name)+'</span>' +
            (st !== 'active' ? '<span class="badge inactive sub-badge">'+esc(STATUS_LABEL[st]||st)+'</span>' : '') +
            '<button class="sub-student-edit" data-edit-student="'+s.id+'" title="학생 정보 수정">✎</button>' +
          '</div>';
        }).join('') || '<div class="sub-empty">학생이 없어요</div>';
        row += '<button class="sub-add-student" data-add-student>+ 학생 추가</button>';
        row += '</div>';
      }
      return row;
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
    var stu = state.selectedStudentId ? getStudent(state.selectedStudentId) : null;
    header.innerHTML =
      '<div class="class-title-row">' +
        '<div>' +
          '<div class="class-title"><span class="class-dot" style="background:'+esc(cls.color||CLASS_COLORS[0])+'"></span>'+esc(cls.name)+
            (stu ? ' <span style="color:var(--ink-soft); font-weight:500; font-size:16px;">· '+esc(stu.name)+'</span>' : '')+
          '</div>' +
          '<div class="class-subtitle">'+esc([cls.school, cls.grade, cls.textbook, cls.schedule].filter(Boolean).join(' · ') || '설명 없음')+' · 학생 '+activeStudents().length+'명</div>' +
        '</div>' +
      '</div>';
  }

  function renderTabNav(){
    var nav = document.getElementById('tabNav');
    if(!state.selectedClassId){ nav.innerHTML=''; return; }
    var tabs = [['record','수업 기록'],['history','히스토리'],['report','리포트']];
    nav.innerHTML = tabs.map(function(t){
      return '<button class="tab-btn '+(state.tab===t[0]?'is-active':'')+'" data-tab="'+t[0]+'">'+t[1]+'</button>';
    }).join('');
  }

  function renderTabContentEmpty(){
    document.getElementById('tabContent').innerHTML =
      '<div class="empty-state">' +
        '<h2>첫 반을 만들어보세요</h2>' +
        '<p>반을 만들고 학생을 등록하면, 매 수업마다 출결·진도·이해도·숙제·특이사항을 몇 번의 클릭으로 기록할 수 있어요.</p>' +
        '<button class="btn btn-primary" id="emptyAddClassBtn">+ 새 반 만들기</button>' +
      '</div>';
    var btn = document.getElementById('emptyAddClassBtn');
    if(btn) btn.addEventListener('click', function(){ openClassModal(); });
  }

  function renderTabContent(){
    if(!state.selectedClassId){ renderTabContentEmpty(); return; }
    if(state.tab === 'record') renderRecordTab();
    else if(state.tab === 'history') renderHistoryTab();
    else renderReportTab();
  }

  // ---------------- record tab ----------------
  function prevRecordFor(studentId, beforeDate){
    return state.classRecords.filter(function(r){ return r.studentId === studentId && r.date < beforeDate; })
      .sort(function(a,b){ return a.date < b.date ? 1 : -1; })[0] || null;
  }

  function chipStatus(sessionId){
    var total = activeStudents().length || 1;
    var recs = state.classRecords.filter(function(r){ return r.sessionId === sessionId; });
    var count = recs.filter(function(r){ return r.progressTo || r.understanding || r.hwToday || r.note; }).length;
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
        '<span class="chip-dot '+chipStatus(s.id)+'"></span>' + formatKoreanDate(s.date,{short:true}) +
      '</button>';
    }).join('') || '<span style="font-size:11.5px; color:var(--ink-faint);">아직 기록된 수업이 없어요.</span>';
  }

  function attBadge(studentId, opts){
    var status = currentAttendance[studentId] || 'present';
    var clickable = opts && opts.clickable;
    return '<button type="button" class="att-badge att-'+status+(clickable?'':' readonly')+'" '+
      (clickable ? 'data-att-toggle="'+studentId+'"' : 'disabled') + '>'+ATT_LABEL[status]+'</button>';
  }

  function renderRecordCard(student, opts){
    opts = opts || {};
    var rec = currentRecords[student.id] || {};
    var status = currentAttendance[student.id] || 'present';
    var isOut = status === 'absent' || status === 'makeup';
    var collapsed = isOut && !opts.forceExpand;
    var prev = prevRecordFor(student.id, currentSession.date);
    var progressFrom = rec.progressFrom != null ? rec.progressFrom : (prev ? (prev.progressTo || '') : '');
    var prevHw = prev && prev.hwToday ? (formatKoreanDate(prev.date,{short:true}) + ' · ' + prev.hwToday) : '';

    var stars = function(field, val){
      var out = '';
      for(var i=1;i<=5;i++){
        out += '<button type="button" class="star '+(val>=i?'is-on':'')+'" data-val="'+i+'" data-student="'+student.id+'" data-star-field="'+field+'" aria-label="'+i+'점">★</button>';
      }
      return out;
    };

    var head = '<div class="rec-card-head">' +
      '<div class="rec-card-name">'+esc(student.name)+(student.phone?'<span class="stu-phone">'+esc(maskPhone(student.phone))+'</span>':'')+'</div>' +
      attBadge(student.id, { clickable: true }) +
    '</div>';

    if(collapsed){
      return '<div class="rec-card is-collapsed" data-card="'+student.id+'">' + head +
        '<div class="rec-card-collapsed-note">'+ATT_LABEL[status]+' 처리됨 · <button class="link-btn" data-expand-card="'+student.id+'">그래도 기록하기</button></div>' +
      '</div>';
    }

    return '<div class="rec-card" data-card="'+student.id+'">' + head +
      '<div class="rec-card-body">' +
        '<div class="rec-field rec-progress">' +
          '<label>진도</label>' +
          '<div class="rec-progress-row">' +
            '<input type="text" class="cell-input" data-student="'+student.id+'" data-field="progressFrom" placeholder="예: Lesson 3 본문" value="'+esc(progressFrom)+'">' +
            '<span class="rec-progress-sep">~</span>' +
            '<input type="text" class="cell-input" data-student="'+student.id+'" data-field="progressTo" placeholder="예: Lesson 3 어법" value="'+esc(rec.progressTo||'')+'">' +
          '</div>' +
        '</div>' +
        '<div class="rec-field-row">' +
          '<div class="rec-field"><label>이해도</label><div class="stars">'+stars('understanding', rec.understanding||0)+'</div><div class="stars-label">'+understandingLabel(rec.understanding)+'</div></div>' +
          '<div class="rec-field"><label>태도</label><div class="stars">'+stars('attitude', rec.attitude||0)+'</div><div class="stars-label">'+understandingLabel(rec.attitude)+'</div></div>' +
        '</div>' +
        '<div class="rec-field-row">' +
          '<div class="rec-field hw-block">' +
            '<label class="check"><input type="checkbox" data-student="'+student.id+'" data-field="hwPrevDone" '+(rec.hwPrevDone?'checked':'')+'><span>지난 숙제 완료</span></label>' +
            '<div class="hw-prev-text" title="'+esc(prevHw||'이전 숙제 없음')+'">'+esc(prevHw || '이전 숙제 없음')+'</div>' +
            '<input type="text" class="cell-input hw-new" data-student="'+student.id+'" data-field="hwToday" placeholder="오늘 낸 숙제" value="'+esc(rec.hwToday||'')+'">' +
          '</div>' +
          '<div class="rec-field"><label>특이사항</label><input type="text" class="cell-input" data-student="'+student.id+'" data-field="note" placeholder="특이사항" value="'+esc(rec.note||'')+'"></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderRecordTab(){
    if(!currentSession) return;
    var wholeClass = !state.selectedStudentId;
    var students = wholeClass ? activeStudents() : [getStudent(state.selectedStudentId)].filter(Boolean);

    var filled = students.filter(function(s){
      var r = currentRecords[s.id];
      return r && (r.progressTo || r.understanding || r.hwToday || r.note);
    }).length;
    var pillFull = students.length > 0 && filled === students.length;

    var topBar = wholeClass ?
      '<div class="record-toolbar">' +
        '<div class="date-nav">' +
          '<button class="step" id="prevDay" title="전날">‹</button>' +
          '<input type="date" id="datePicker" value="'+state.selectedDate+'">' +
          '<button class="step" id="nextDay" title="다음날">›</button>' +
          '<button class="btn btn-sm" id="todayBtn">오늘</button>' +
          '<span class="date-label">'+formatKoreanDate(state.selectedDate)+'</span>' +
        '</div>' +
        '<div class="progress-pill '+(pillFull?'is-full':'')+'">'+filled+' / '+students.length+'명 기록</div>' +
      '</div>' :
      '<div class="record-toolbar"><div class="date-label">'+formatKoreanDate(currentSession.date)+' 기록</div></div>';

    var attBar = wholeClass ?
      '<div class="att-bar" id="attBar">' + students.map(function(s){
        var status = currentAttendance[s.id] || 'present';
        return '<button type="button" class="att-chip att-'+status+'" data-att-toggle="'+s.id+'">'+esc(s.name)+' · '+ATT_LABEL[status]+'</button>';
      }).join('') + '</div>' : '';

    var anyHw = Object.keys(currentRecords).some(function(sid){ return currentRecords[sid] && currentRecords[sid].hwToday; });

    var sessionMeta = wholeClass ?
      '<div class="session-meta">' +
        '<input type="text" id="topicInput" class="topic-input" placeholder="오늘 수업 내용 (예: Lesson 3 본문 + 어법)" value="'+esc(currentSession.topic||'')+'">' +
        '<input type="text" id="materialInput" class="session-memo-input" placeholder="교재/시험지 참조 (선택)" value="'+esc(currentSession.materialRef||'')+'">' +
        (anyHw ? '<button class="btn btn-sm" id="applyHwAllBtn">숙제 전체 적용</button>' : '') +
      '</div>' : '';

    var dateChips = wholeClass ? '<div class="date-chips" id="dateChips"></div>' : '';

    var cardsHtml = students.length ?
      students.map(function(s){ return renderRecordCard(s); }).join('') :
      '<div class="empty-state"><h2>학생이 없어요</h2><p>사이드바에서 "+ 학생 추가"로 이 반에 학생을 등록해 주세요.</p></div>';

    var summaryHtml = '';
    if(!wholeClass && students[0]){
      var recent = state.classRecords.filter(function(r){ return r.studentId === students[0].id; })
        .sort(function(a,b){ return a.date < b.date ? 1 : -1; }).slice(0, 5);
      summaryHtml = '<div class="recent-summary"><h3>최근 5회 요약</h3>' +
        (recent.length ? recent.map(function(r){
          return '<div class="recent-row"><span class="mono">'+formatKoreanDate(r.date,{short:true})+'</span>' +
            '<span>'+esc(r.progressTo || '진도 기록 없음')+'</span>' +
            '<span>이해도 '+understandingLabel(r.understanding)+'</span></div>';
        }).join('') : '<div class="tl-note">기록이 없어요.</div>') +
      '</div>';
    }

    document.getElementById('tabContent').innerHTML = topBar + attBar + sessionMeta + dateChips +
      '<div class="rec-cards" id="recCards">' + cardsHtml + '</div>' + summaryHtml;

    if(wholeClass) renderDateChips();
    wireRecordEvents(wholeClass);
  }

  function wireRecordEvents(wholeClass){
    if(wholeClass){
      document.getElementById('prevDay').addEventListener('click', function(){ changeDate(shiftDate(state.selectedDate,-1)); });
      document.getElementById('nextDay').addEventListener('click', function(){ changeDate(shiftDate(state.selectedDate,1)); });
      document.getElementById('todayBtn').addEventListener('click', function(){ changeDate(todayStr()); });
      document.getElementById('datePicker').addEventListener('change', function(e){ if(e.target.value) changeDate(e.target.value); });
      document.getElementById('topicInput').addEventListener('input', function(e){
        currentSession.topic = e.target.value;
        debouncedSessionSave('topic', e.target.value);
      });
      document.getElementById('materialInput').addEventListener('input', function(e){
        currentSession.materialRef = e.target.value;
        debouncedSessionSave('materialRef', e.target.value);
      });
      wireApplyHwButton();
      var attBar = document.getElementById('attBar');
      if(attBar) attBar.addEventListener('click', function(e){
        var btn = e.target.closest('[data-att-toggle]');
        if(btn) cycleAttendance(btn.getAttribute('data-att-toggle'));
      });
    }

    var cards = document.getElementById('recCards');
    cards.addEventListener('click', function(e){
      var attBtn = e.target.closest('[data-att-toggle]');
      if(attBtn){ cycleAttendance(attBtn.getAttribute('data-att-toggle')); return; }
      var expandBtn = e.target.closest('[data-expand-card]');
      if(expandBtn){
        var sid = expandBtn.getAttribute('data-expand-card');
        var card = cards.querySelector('[data-card="'+sid+'"]');
        var student = getStudent(sid);
        if(card && student) card.outerHTML = renderRecordCard(student, { forceExpand: true });
        return;
      }
      var star = e.target.closest('.star');
      if(star){
        var studentId = star.dataset.student;
        var field = star.dataset.starField;
        var val = Number(star.dataset.val);
        var wrap = star.closest('.stars');
        Array.prototype.forEach.call(wrap.querySelectorAll('.star'), function(st){
          st.classList.toggle('is-on', Number(st.dataset.val) <= val);
        });
        wrap.parentElement.querySelector('.stars-label').textContent = understandingLabel(val);
        updateLocalRecord(studentId, field, val);
        commitRecordField(studentId, field, val);
      }
    });
    cards.addEventListener('input', function(e){
      var t = e.target;
      if(t.matches('input.cell-input')){
        var studentId = t.dataset.student, field = t.dataset.field;
        updateLocalRecord(studentId, field, t.value);
        if(field === 'hwToday'){ lastHwToday = t.value; updateApplyHwButtonVisibility(); }
        debouncedRecordSave(studentId, field, t.value);
      }
    });
    cards.addEventListener('change', function(e){
      var t = e.target;
      if(t.matches('input[type=checkbox][data-field=hwPrevDone]')){
        var studentId = t.dataset.student;
        updateLocalRecord(studentId, 'hwPrevDone', t.checked);
        commitRecordField(studentId, 'hwPrevDone', t.checked);
      }
    });
    document.getElementById('dateChips') && document.getElementById('dateChips').addEventListener('click', function(e){
      var chip = e.target.closest('[data-jump]');
      if(chip) changeDate(chip.getAttribute('data-jump'));
    });
  }

  // ---------------- student modal ----------------
  function openStudentModal(studentId){
    var editing = studentId ? getStudent(studentId) : null;
    state.modalOpen = true;
    document.getElementById('modalRoot').innerHTML =
      '<div class="modal-backdrop" id="modalBackdrop"><div class="modal">' +
        '<h3>'+(editing?'학생 정보 수정':'학생 추가')+'</h3>' +
        '<div class="field"><label>이름 *</label><input type="text" id="mStuName" value="'+esc(editing?editing.name:'')+'" placeholder="예: 박지후"></div>' +
        '<div class="field"><label>학교/학년</label><div style="display:flex; gap:8px;">' +
          '<input type="text" id="mStuSchool" value="'+esc(editing?editing.school:'')+'" placeholder="학교" style="flex:1;">' +
          '<input type="text" id="mStuGrade" value="'+esc(editing?editing.grade:'')+'" placeholder="학년" style="width:90px;">' +
        '</div></div>' +
        '<div class="field"><label>연락처</label><input type="text" id="mStuPhone" value="'+esc(editing?editing.phone:'')+'" placeholder="010-0000-0000"></div>' +
        '<div class="field"><label>학부모 연락처</label><input type="text" id="mStuParent" value="'+esc(editing?editing.parentPhone:'')+'" placeholder="010-0000-0000"></div>' +
        (editing ? '<div class="field"><label>상태</label><select id="mStuStatus" style="width:100%; background:var(--bg); border:1px solid var(--line); border-radius:var(--radius-sm); padding:9px 11px; font-size:13.5px;">' +
          ['active','paused','left'].map(function(s){ return '<option value="'+s+'" '+((editing.status||'active')===s?'selected':'')+'>'+STATUS_LABEL[s]+'</option>'; }).join('') +
        '</select></div>' : '') +
        '<div class="field"><label>메모</label><textarea id="mStuNote" rows="2" placeholder="인수인계에 남을 특이사항 (선택)">'+esc(editing?editing.memo:'')+'</textarea></div>' +
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
        school: document.getElementById('mStuSchool').value.trim(),
        grade: document.getElementById('mStuGrade').value.trim(),
        phone: document.getElementById('mStuPhone').value.trim(),
        parentPhone: document.getElementById('mStuParent').value.trim(),
        memo: document.getElementById('mStuNote').value.trim()
      };
      if(editing){
        data.status = document.getElementById('mStuStatus').value;
        db.students.update(editing.id, data)
          .then(function(){ showToast('저장됨'); closeModal(); refreshClassData(state.selectedClassId); })
          .catch(function(){ showToast('저장 실패', true); });
      } else {
        db.students.create(data).then(function(res){
          return db.enrollments.create({ studentId: res.id, classId: state.selectedClassId });
        }).then(function(){ showToast('저장됨'); closeModal(); refreshClassData(state.selectedClassId); })
          .catch(function(){ showToast('저장 실패', true); });
      }
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
        '<div class="field"><label>반 이름 *</label><input type="text" id="mClsName" value="'+esc(editing?editing.name:'')+'" placeholder="예: 고2 내신 A"></div>' +
        '<div class="field"><label>학교/학년</label><div style="display:flex; gap:8px;">' +
          '<input type="text" id="mClsSchool" value="'+esc(editing?editing.school:'')+'" placeholder="예: 사대부고" style="flex:1;">' +
          '<input type="text" id="mClsGrade" value="'+esc(editing?editing.grade:'')+'" placeholder="예: 고2" style="width:90px;">' +
        '</div></div>' +
        '<div class="field"><label>교재</label><input type="text" id="mClsTextbook" value="'+esc(editing?editing.textbook:'')+'" placeholder="예: 능률(오) 영어2"></div>' +
        '<div class="field"><label>요일·시간</label><input type="text" id="mClsSchedule" value="'+esc(editing?editing.schedule:'')+'" placeholder="예: 월수금 19:00"></div>' +
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
        school: document.getElementById('mClsSchool').value.trim(),
        grade: document.getElementById('mClsGrade').value.trim(),
        textbook: document.getElementById('mClsTextbook').value.trim(),
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
  function periodRange(){
    if(state.historyPeriod === '1m') return { from: monthsAgoStr(1), to: todayStr() };
    if(state.historyPeriod === '3m') return { from: monthsAgoStr(3), to: todayStr() };
    if(state.historyPeriod === 'custom') return { from: state.historyFrom || '', to: state.historyTo || '' };
    return { from: '', to: '' }; // 'all'
  }

  function buildTimelineForStudent(sid, from, to){
    var sessById = {}; state.sessions.forEach(function(s){ sessById[s.id] = s; });
    var recBySession = {}; state.classRecords.forEach(function(r){ if(r.studentId===sid) recBySession[r.sessionId] = r; });
    var attBySession = {}; state.classAttendance.forEach(function(a){ if(a.studentId===sid) attBySession[a.sessionId] = a; });
    var ids = {};
    Object.keys(recBySession).forEach(function(id){ ids[id]=true; });
    Object.keys(attBySession).forEach(function(id){ ids[id]=true; });
    return Object.keys(ids).map(function(id){
      var s = sessById[id];
      if(!s) return null;
      return { session: s, record: recBySession[id]||null, attendance: attBySession[id]||null, status: (attBySession[id]||{}).status || 'present' };
    }).filter(function(x){ return x && dateInRange(x.session.date, from, to); })
      .sort(function(a,b){ return a.session.date < b.session.date ? 1 : -1; });
  }

  function renderHistoryTab(){
    var students = state.students.slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||'','ko'); });
    if(!students.length){
      document.getElementById('tabContent').innerHTML = '<div class="empty-state"><h2>학생을 먼저 등록해 주세요</h2><p>학생을 추가하면 이 곳에서 개인별 히스토리를 볼 수 있어요.</p></div>';
      return;
    }
    var sid = state.selectedStudentId;
    if(!sid){
      if(!state.historyStudentId || !students.find(function(s){return s.id===state.historyStudentId;})) state.historyStudentId = students[0].id;
      sid = state.historyStudentId;
    }
    var student = getStudent(sid);
    var range = periodRange();
    var timeline = buildTimelineForStudent(sid, range.from, range.to);

    var totalSessions = timeline.length;
    var presentLike = timeline.filter(function(e){ return e.status === 'present' || e.status === 'late'; }).length;
    var attendanceRate = totalSessions ? Math.round(presentLike/totalSessions*100) : null;
    var understandingVals = timeline.filter(function(e){ return e.record && e.record.understanding; }).map(function(e){ return e.record.understanding; });
    var avgUnderstanding = understandingVals.length ? (understandingVals.reduce(function(a,b){return a+b;},0)/understandingVals.length) : 0;
    var hwTracked = timeline.filter(function(e){ return e.record && e.record.hwPrevDone !== undefined; });
    var hwDone = hwTracked.filter(function(e){ return e.record.hwPrevDone; }).length;
    var hwRate = hwTracked.length ? Math.round(hwDone/hwTracked.length*100) : null;

    var shownTimeline = state.handoff ? timeline.filter(function(e){ return e.record && e.record.note; }) : timeline;

    var pickerHtml = sid ?
      (state.selectedStudentId ? '' : '<select id="historySelect">' + students.map(function(s){ return '<option value="'+s.id+'" '+(s.id===sid?'selected':'')+'>'+esc(s.name)+'</option>'; }).join('') + '</select>') : '';

    var periodHtml = '<div class="period-filter">' +
      [['1m','최근 1개월'],['3m','최근 3개월'],['all','전체'],['custom','직접 지정']].map(function(p){
        return '<button class="btn btn-sm period-btn '+(state.historyPeriod===p[0]?'is-active':'')+'" data-period="'+p[0]+'">'+p[1]+'</button>';
      }).join('') +
      (state.historyPeriod==='custom' ?
        '<input type="date" id="histFrom" value="'+esc(state.historyFrom)+'"><span>~</span><input type="date" id="histTo" value="'+esc(state.historyTo)+'">' : '') +
    '</div>';

    var handoffHtml = '<label class="check" style="margin-left:auto;"><input type="checkbox" id="handoffToggle" '+(state.handoff?'checked':'')+'><span>인수인계 보기</span></label>';

    var memoHtml = (state.handoff && student && student.memo) ?
      '<div class="handoff-memo"><strong>학생 메모</strong><p>'+esc(student.memo)+'</p></div>' : '';

    var timelineHtml = shownTimeline.map(function(e){
      var r = e.record || {};
      var starsRo = '';
      for(var i=1;i<=5;i++) starsRo += '<span class="star readonly '+(r.understanding>=i?'is-on':'')+'">★</span>';
      return '<div class="timeline-item '+(r.note?'has-note':'')+'">' +
        '<div class="tl-date">'+formatKoreanDate(e.session.date,{short:true})+'</div>' +
        '<div class="tl-body">' +
          '<div class="tl-row"><span class="att-badge att-'+e.status+' readonly">'+ATT_LABEL[e.status]+'</span>' +
            (e.session.topic ? '<span class="tl-topic">'+esc(e.session.topic)+'</span>' : '') + '</div>' +
          '<div class="tl-progress">'+esc((r.progressFrom||'')+(r.progressFrom&&r.progressTo?' ~ ':'')+(r.progressTo||'') || '진도 기록 없음')+'</div>' +
          '<div class="tl-row">' +
            '<span>'+starsRo+' '+understandingLabel(r.understanding)+'</span>' +
            (r.hwToday ? '<span class="hw-badge '+(r.hwPrevDone?'done':'undone')+'">'+(r.hwPrevDone?'숙제 완료':'숙제 미완료')+'</span>' : '') +
          '</div>' +
          (r.hwToday ? '<div class="tl-note">숙제: '+esc(r.hwToday)+'</div>' : '') +
          (r.note ? '<div class="tl-note">특이사항: '+esc(r.note)+'</div>' : '') +
        '</div>' +
      '</div>';
    }).join('') || '<div class="empty-state" style="padding:30px 0;"><p>표시할 기록이 없어요.</p></div>';

    document.getElementById('tabContent').innerHTML =
      '<div class="history-picker">' + pickerHtml + periodHtml + handoffHtml + '</div>' +
      memoHtml +
      '<div class="stat-row">' +
        '<div class="stat-tile"><div class="num mono">'+(attendanceRate!==null?attendanceRate+'%':'-')+'</div><div class="lbl">출석률</div></div>' +
        '<div class="stat-tile"><div class="num mono">'+(avgUnderstanding?avgUnderstanding.toFixed(1):'-')+'</div><div class="lbl">평균 이해도 (5점)</div></div>' +
        '<div class="stat-tile"><div class="num mono">'+(hwRate!==null?hwRate+'%':'-')+'</div><div class="lbl">숙제 완료율</div></div>' +
        '<div class="stat-tile"><div class="num mono">'+totalSessions+'</div><div class="lbl">총 수업 횟수</div></div>' +
      '</div>' +
      '<div class="timeline">'+timelineHtml+'</div>';

    var sel = document.getElementById('historySelect');
    if(sel) sel.addEventListener('change', function(e){ state.historyStudentId = e.target.value; renderHistoryTab(); });
    document.querySelectorAll('.period-btn').forEach(function(btn){
      btn.addEventListener('click', function(){ state.historyPeriod = btn.getAttribute('data-period'); renderHistoryTab(); });
    });
    var hf = document.getElementById('histFrom'), ht = document.getElementById('histTo');
    if(hf) hf.addEventListener('change', function(e){ state.historyFrom = e.target.value; renderHistoryTab(); });
    if(ht) ht.addEventListener('change', function(e){ state.historyTo = e.target.value; renderHistoryTab(); });
    document.getElementById('handoffToggle').addEventListener('change', function(e){ state.handoff = e.target.checked; renderHistoryTab(); });
  }

  // ---------------- report tab ----------------
  function buildReportDraft(student, from, to, timeline){
    var name = student.name;
    var presentCount = timeline.filter(function(e){ return e.status==='present'; }).length;
    var lateCount = timeline.filter(function(e){ return e.status==='late'; }).length;
    var absentCount = timeline.filter(function(e){ return e.status==='absent'; }).length;
    var makeupCount = timeline.filter(function(e){ return e.status==='makeup'; }).length;
    var total = timeline.length;
    var attRate = total ? Math.round((presentCount+lateCount)/total*100) : 0;

    var withProgress = timeline.filter(function(e){ return e.record && (e.record.progressFrom || e.record.progressTo); })
      .sort(function(a,b){ return a.session.date < b.session.date ? -1 : 1; });
    var progressLine = withProgress.length ?
      (withProgress[0].record.progressFrom || withProgress[0].record.progressTo) + ' ~ ' + (withProgress[withProgress.length-1].record.progressTo || withProgress[withProgress.length-1].record.progressFrom) + '까지 진행했습니다.' :
      '이 기간 진도 기록이 없습니다.';

    var understandingVals = timeline.filter(function(e){ return e.record && e.record.understanding; }).map(function(e){ return e.record.understanding; });
    var attitudeVals = timeline.filter(function(e){ return e.record && e.record.attitude; }).map(function(e){ return e.record.attitude; });
    var avgU = understandingVals.length ? (understandingVals.reduce(function(a,b){return a+b;},0)/understandingVals.length).toFixed(1) : '-';
    var avgA = attitudeVals.length ? (attitudeVals.reduce(function(a,b){return a+b;},0)/attitudeVals.length).toFixed(1) : '-';
    var hwTracked = timeline.filter(function(e){ return e.record && e.record.hwPrevDone !== undefined; });
    var hwDone = hwTracked.filter(function(e){ return e.record.hwPrevDone; }).length;
    var hwRate = hwTracked.length ? Math.round(hwDone/hwTracked.length*100) : null;

    var notes = timeline.filter(function(e){ return e.record && e.record.note; })
      .sort(function(a,b){ return a.session.date < b.session.date ? -1 : 1; })
      .map(function(e){ return '- '+formatKoreanDate(e.session.date,{short:true})+' '+e.record.note; });

    var lines = [];
    lines.push('['+name+' 학생 학습 리포트]');
    lines.push('기간: '+from+' ~ '+to+' (총 '+total+'회)');
    lines.push('');
    lines.push('■ 출결');
    lines.push('출석 '+presentCount+'회, 지각 '+lateCount+'회, 결석 '+absentCount+'회'+(makeupCount?', 보강 '+makeupCount+'회':'')+' (출석률 '+attRate+'%)');
    lines.push('');
    lines.push('■ 진도');
    lines.push(progressLine);
    lines.push('');
    lines.push('■ 학습 태도 및 이해도');
    lines.push('평균 이해도 '+avgU+'/5, 수업 태도 '+avgA+'/5입니다.');
    lines.push(hwRate!==null ? ('숙제 완료율 '+hwRate+'% ('+hwTracked.length+'회 중 '+hwDone+'회).') : '숙제 기록이 없습니다.');
    lines.push('');
    lines.push('■ 특이사항');
    lines.push(notes.length ? notes.join('\n') : '특이사항 없음');
    lines.push('');
    lines.push('■ 담당 교사 코멘트');
    lines.push('(직접 작성)');
    return lines.join('\n');
  }

  function renderReportTab(){
    var students = state.students.slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||'','ko'); });
    if(!students.length){
      document.getElementById('tabContent').innerHTML = '<div class="empty-state"><h2>학생을 먼저 등록해 주세요</h2><p>학생을 추가하면 이 곳에서 학부모 리포트를 만들 수 있어요.</p></div>';
      return;
    }
    var sid = state.selectedStudentId || state.reportStudentId || students[0].id;
    state.reportStudentId = sid;
    var student = getStudent(sid);

    db.reports.getByStudent(sid).then(function(list){
      state.reportList = list;
      paint();
    });

    function paint(){
      var pickerHtml = state.selectedStudentId ? '' :
        '<select id="reportSelect">' + students.map(function(s){ return '<option value="'+s.id+'" '+(s.id===sid?'selected':'')+'>'+esc(s.name)+'</option>'; }).join('') + '</select>';

      var prevListHtml = state.reportList.length ?
        '<div class="report-prev-list">' + state.reportList.map(function(r){
          return '<button class="report-prev-item" data-load-report="'+r.id+'">'+esc(r.periodFrom)+' ~ '+esc(r.periodTo)+'</button>';
        }).join('') + '</div>' : '<div class="tl-note">이전 리포트가 없어요.</div>';

      document.getElementById('tabContent').innerHTML =
        '<div class="report-layout">' +
          '<div class="report-side">' +
            '<h3>이전 리포트</h3>' + prevListHtml +
          '</div>' +
          '<div class="report-main">' +
            '<div class="history-picker">' + pickerHtml +
              '<input type="date" id="repFrom" value="'+esc(state.reportFrom)+'">' +
              '<span>~</span>' +
              '<input type="date" id="repTo" value="'+esc(state.reportTo)+'">' +
              '<button class="btn btn-primary" id="genReportBtn">생성</button>' +
            '</div>' +
            '<textarea id="reportDraft" class="report-textarea" rows="20" placeholder="\'생성\' 버튼을 눌러 초안을 만들어 보세요.">'+esc(state.reportDraft)+'</textarea>' +
            '<div class="modal-actions">' +
              '<button class="btn" id="copyReportBtn">복사</button>' +
              '<button class="btn btn-primary" id="saveReportBtn">저장</button>' +
            '</div>' +
          '</div>' +
        '</div>';

      var sel = document.getElementById('reportSelect');
      if(sel) sel.addEventListener('change', function(e){ state.reportStudentId = e.target.value; state.reportDraft=''; state.reportSavedId=null; renderReportTab(); });
      document.getElementById('repFrom').addEventListener('change', function(e){ state.reportFrom = e.target.value; });
      document.getElementById('repTo').addEventListener('change', function(e){ state.reportTo = e.target.value; });
      document.getElementById('genReportBtn').addEventListener('click', function(){
        var range = { from: state.reportFrom, to: state.reportTo };
        var timeline = buildTimelineForStudent(sid, range.from, range.to);
        state.reportDraft = buildReportDraft(student, range.from, range.to, timeline);
        state.reportSavedId = null;
        document.getElementById('reportDraft').value = state.reportDraft;
        showToast('초안을 생성했어요');
      });
      document.getElementById('reportDraft').addEventListener('input', function(e){ state.reportDraft = e.target.value; });
      document.getElementById('copyReportBtn').addEventListener('click', function(){
        var text = document.getElementById('reportDraft').value;
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(text).then(function(){ showToast('복사했어요'); }).catch(function(){ showToast('복사 실패', true); });
        } else {
          showToast('이 브라우저는 복사를 지원하지 않아요', true);
        }
      });
      document.getElementById('saveReportBtn').addEventListener('click', function(){
        var body = document.getElementById('reportDraft').value;
        if(!body.trim()){ showToast('내용이 비어 있어요', true); return; }
        var data = { studentId: sid, periodFrom: state.reportFrom, periodTo: state.reportTo, body: body };
        var p = state.reportSavedId ? db.reports.update(state.reportSavedId, data) : db.reports.create(data);
        p.then(function(res){
          if(res && res.id) state.reportSavedId = res.id;
          showToast('저장됨');
          renderReportTab();
        }).catch(function(){ showToast('저장 실패', true); });
      });
      document.querySelectorAll('[data-load-report]').forEach(function(btn){
        btn.addEventListener('click', function(){
          var id = btn.getAttribute('data-load-report');
          var r = state.reportList.find(function(x){ return x.id === id; });
          if(!r) return;
          state.reportSavedId = r.id;
          state.reportDraft = r.body;
          state.reportFrom = r.periodFrom;
          state.reportTo = r.periodTo;
          renderReportTab();
        });
      });
    }
  }

  // ---------------- global event wiring (static shell) ----------------
  document.getElementById('classList').addEventListener('click', function(e){
    var editBtn = e.target.closest('[data-edit]');
    if(editBtn){ openClassModal(editBtn.getAttribute('data-edit')); return; }
    var editStuBtn = e.target.closest('[data-edit-student]');
    if(editStuBtn){ openStudentModal(editStuBtn.getAttribute('data-edit-student')); return; }
    var addStuBtn = e.target.closest('[data-add-student]');
    if(addStuBtn){ openStudentModal(); return; }
    var backBtn = e.target.closest('[data-back-whole]');
    if(backBtn){ backToWholeClass(); return; }
    var stuRow = e.target.closest('[data-student]');
    if(stuRow){ selectStudent(stuRow.getAttribute('data-student')); return; }
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
