// db.js — the ONLY data API the screen code (app.js) is allowed to call.
//
// Target shape (see v2 spec §3), plus a few `*.listByClass` helpers that are
// NOT in the spec's interface but are cheap to offer locally and save app.js
// from re-deriving joins by hand. A future SupabaseAdapter can implement them
// as a single join query, or app.js can be adjusted to do without them —
// they're a convenience, not a contract:
//
//   db.classes     { list, get, create, update, archive }
//   db.students    { listByClass, get, create, update, setStatus }
//   db.enrollments { listByStudent, listByClass*, create, end }
//   db.sessions    { listByClass, getByDate, create, update }
//   db.attendance  { getBySession, listByClass*, upsertMany }
//   db.records     { getBySession, getByStudent, listByClass*, upsert }
//   db.reports     { getByStudent, create, update }
//
// This is the MVP-without-Supabase adapter: everything lives in
// localStorage, scoped to one browser. No auth, no sharing across devices.
// Swapping in SupabaseAdapter later (spec step 4) means changing only this
// file — the shape above is designed to map 1:1 onto the SQL tables in the
// spec so that swap doesn't ripple into app.js.

var LS_PREFIX = 'pt_';

function uid(){ return 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function nowIso(){ return new Date().toISOString(); }
function todayStr(){
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function loadTable(name){
  try { return JSON.parse(localStorage.getItem(LS_PREFIX + name) || '[]'); }
  catch(e){ console.error('db: corrupt table', name, e); return []; }
}
function saveTable(name, rows){
  localStorage.setItem(LS_PREFIX + name, JSON.stringify(rows));
}
function genericGet(name, id){
  return Promise.resolve(loadTable(name).find(function(r){ return r.id === id; }) || null);
}
function genericCreate(name, data, defaults){
  var rows = loadTable(name);
  var row = Object.assign({ id: uid(), createdAt: nowIso() }, defaults, data);
  rows.push(row);
  saveTable(name, rows);
  return Promise.resolve({ id: row.id });
}
function genericUpdate(name, id, data){
  var rows = loadTable(name);
  var idx = rows.findIndex(function(r){ return r.id === id; });
  if(idx < 0) return Promise.reject(new Error(name + ' ' + id + ' not found'));
  rows[idx] = Object.assign({}, rows[idx], data);
  saveTable(name, rows);
  return Promise.resolve();
}

function LocalStorageAdapter(){

  var classes = {
    list: function(){
      return Promise.resolve(loadTable('classes').slice()
        .sort(function(a,b){ return (a.createdAt||'').localeCompare(b.createdAt||''); }));
    },
    get: function(id){ return genericGet('classes', id); },
    create: function(data){ return genericCreate('classes', data, { archived: false }); },
    update: function(id, data){ return genericUpdate('classes', id, data); },
    archive: function(id, archived){ return genericUpdate('classes', id, { archived: !!archived }); }
  };

  // ---- enrollments (student <-> class membership, with history) ----
  var enrollments = {
    listByStudent: function(studentId){
      return Promise.resolve(loadTable('enrollments').filter(function(e){ return e.studentId === studentId; }));
    },
    // extra helper (not in spec interface): active enrollments for a class.
    listByClass: function(classId){
      return Promise.resolve(loadTable('enrollments').filter(function(e){ return e.classId === classId && !e.leaveDate; }));
    },
    create: function(data){
      return genericCreate('enrollments', data, { joinDate: data.joinDate || todayStr() });
    },
    end: function(id, leaveDate){
      return genericUpdate('enrollments', id, { leaveDate: leaveDate || todayStr() });
    }
  };

  var students = {
    listByClass: function(classId){
      return enrollments.listByClass(classId).then(function(rows){
        var ids = rows.map(function(r){ return r.studentId; });
        return loadTable('students').filter(function(s){ return ids.indexOf(s.id) !== -1; })
          .sort(function(a,b){ return (a.name||'').localeCompare(b.name||'', 'ko'); });
      });
    },
    get: function(id){ return genericGet('students', id); },
    create: function(data){ return genericCreate('students', data, { status: 'active' }); },
    update: function(id, data){ return genericUpdate('students', id, data); },
    setStatus: function(id, status){ return genericUpdate('students', id, { status: status }); }
  };

  // ---- sessions ----
  var sessions = {
    listByClass: function(classId, limit){
      return Promise.resolve(loadTable('sessions').filter(function(s){ return s.classId === classId; })
        .sort(function(a,b){ return a.date < b.date ? 1 : -1; })
        .slice(0, limit || 500));
    },
    getByDate: function(classId, date){
      return Promise.resolve(loadTable('sessions').find(function(s){ return s.classId === classId && s.date === date; }) || null);
    },
    create: function(classId, date, data){
      return genericCreate('sessions', Object.assign({ classId: classId, date: date }, data), { topic: '', materialRef: '' });
    },
    update: function(id, data){ return genericUpdate('sessions', id, data); }
  };

  // ---- attendance ----
  var attendance = {
    getBySession: function(sessionId){
      return Promise.resolve(loadTable('attendance').filter(function(a){ return a.sessionId === sessionId; }));
    },
    // extra helper: every attendance row for sessions belonging to a class (date-joined).
    listByClass: function(classId){
      return sessions.listByClass(classId, 100000).then(function(sess){
        var sessById = {}; sess.forEach(function(s){ sessById[s.id] = s; });
        return loadTable('attendance').filter(function(a){ return sessById[a.sessionId]; })
          .map(function(a){ return Object.assign({}, a, { date: sessById[a.sessionId].date }); });
      });
    },
    upsertMany: function(sessionId, list){
      var rows = loadTable('attendance');
      list.forEach(function(item){
        var idx = rows.findIndex(function(r){ return r.sessionId === sessionId && r.studentId === item.studentId; });
        if(idx >= 0) rows[idx] = Object.assign({}, rows[idx], item);
        else rows.push(Object.assign({ id: uid(), sessionId: sessionId }, item));
      });
      saveTable('attendance', rows);
      return Promise.resolve();
    }
  };

  // ---- records ----
  var records = {
    getBySession: function(sessionId){
      return Promise.resolve(loadTable('records').filter(function(r){ return r.sessionId === sessionId; }));
    },
    getByStudent: function(studentId){
      var recs = loadTable('records').filter(function(r){ return r.studentId === studentId; });
      var sessById = {}; loadTable('sessions').forEach(function(s){ sessById[s.id] = s; });
      return Promise.resolve(recs.map(function(r){ return Object.assign({}, r, { session: sessById[r.sessionId] }); })
        .filter(function(r){ return r.session; })
        .sort(function(a,b){ return a.session.date < b.session.date ? 1 : -1; }));
    },
    // extra helper: every record row for sessions belonging to a class (for progress/hw carry-over).
    listByClass: function(classId){
      return sessions.listByClass(classId, 100000).then(function(sess){
        var sessById = {}; sess.forEach(function(s){ sessById[s.id] = s; });
        return loadTable('records').filter(function(r){ return sessById[r.sessionId]; })
          .map(function(r){ return Object.assign({}, r, { date: sessById[r.sessionId].date }); });
      });
    },
    upsert: function(sessionId, studentId, fields){
      var rows = loadTable('records');
      var idx = rows.findIndex(function(r){ return r.sessionId === sessionId && r.studentId === studentId; });
      var now = nowIso();
      if(idx >= 0) rows[idx] = Object.assign({}, rows[idx], fields, { updatedAt: now });
      else rows.push(Object.assign({ id: uid(), sessionId: sessionId, studentId: studentId, updatedAt: now }, fields));
      saveTable('records', rows);
      return Promise.resolve();
    }
  };

  // ---- reports ----
  var reports = {
    getByStudent: function(studentId){
      return Promise.resolve(loadTable('reports').filter(function(r){ return r.studentId === studentId; })
        .sort(function(a,b){ return (b.createdAt||'').localeCompare(a.createdAt||''); }));
    },
    create: function(data){ return genericCreate('reports', data, {}); },
    update: function(id, data){ return genericUpdate('reports', id, data); }
  };

  return {
    ready: Promise.resolve(true),
    classes: classes,
    students: students,
    enrollments: enrollments,
    sessions: sessions,
    attendance: attendance,
    records: records,
    reports: reports
  };
}

export const db = LocalStorageAdapter();
