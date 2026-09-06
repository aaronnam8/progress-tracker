// db.js — the ONLY data API the screen code (app.js) is allowed to call.
//
// Target shape (see v2 spec §3):
//   db.classes     { list, get, create, update, archive }
//   db.students    { listByClass, get, create, update, setStatus }
//   db.enrollments { listByStudent, create, end }
//   db.sessions    { listByClass, getByDate, create, update }
//   db.attendance  { getBySession, upsertMany }
//   db.records     { getBySession, getByStudent, upsert }
//   db.reports     { getByStudent, create, update }
//
// When the backend moves to Supabase (spec step 4), only this file changes —
// swap the `ClaudeAdapter()` call at the bottom for `SupabaseAdapter(...)`.
//
// IMPORTANT — this is an interim adapter. It talks to `window.claude.use('db')`,
// which only exists inside a Claude artifact — it is NOT available on the
// Netlify deploy. It has no realtime subscriptions: callers must re-fetch
// (list / getByDate) after a write to see the change reflected elsewhere.
// enrollments / attendance / reports have no backing table yet in the legacy
// schema, so those methods reject until the schema is extended (spec step 5+).

function uid(){ return 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function nowIso(){ return new Date().toISOString(); }
function sessionIdFor(classId, date){ return classId + '__' + date; }

function notImplemented(name, step){
  return function(){ return Promise.reject(new Error(name + ' is not implemented yet — see v2 spec ' + step)); };
}

function ClaudeAdapter(){
  var raw = null; // resolves to window.claude's db namespace, or stays null if unavailable
  var readyPromise = (window.claude && window.claude.use ? window.claude.use('db') : Promise.resolve(null))
    .then(function(ns){ raw = ns || null; return !!raw; })
    .catch(function(){ raw = null; return false; });

  function need(){
    return readyPromise.then(function(ok){
      if(!ok || !raw) throw new Error('db unavailable — not running inside a Claude artifact');
      return raw;
    });
  }

  // ---- classes ----
  var classes = {
    list: function(){
      return need().then(function(raw){
        return raw.collection('classes').orderBy('createdAt', 'asc').get().then(function(snap){
          return snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
        });
      });
    },
    get: function(id){
      return need().then(function(raw){
        return raw.doc('classes/' + id).get().then(function(snap){
          return snap.exists ? Object.assign({ id: snap.id }, snap.data()) : null;
        });
      });
    },
    create: function(data){
      return need().then(function(raw){
        return raw.collection('classes').add(Object.assign({ archived: false, createdAt: nowIso() }, data))
          .then(function(ref){ return { id: ref.id }; });
      });
    },
    update: function(id, data){
      return need().then(function(raw){ return raw.doc('classes/' + id).update(data); });
    },
    archive: function(id, archived){
      return need().then(function(raw){ return raw.doc('classes/' + id).update({ archived: archived }); });
    }
  };

  // ---- students ----
  // NOTE: legacy schema keeps classId directly on the student (no enrollment table yet).
  var students = {
    listByClass: function(classId){
      return need().then(function(raw){
        return raw.collection('students').where('classId', '==', classId).get().then(function(snap){
          return snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
            .sort(function(a, b){ return (a.name || '').localeCompare(b.name || '', 'ko'); });
        });
      });
    },
    get: function(id){
      return need().then(function(raw){
        return raw.doc('students/' + id).get().then(function(snap){
          return snap.exists ? Object.assign({ id: snap.id }, snap.data()) : null;
        });
      });
    },
    create: function(data){
      return need().then(function(raw){
        return raw.collection('students').add(Object.assign({ active: true, createdAt: nowIso() }, data))
          .then(function(ref){ return { id: ref.id }; });
      });
    },
    update: function(id, data){
      return need().then(function(raw){ return raw.doc('students/' + id).update(data); });
    },
    setStatus: function(id, active){
      return need().then(function(raw){ return raw.doc('students/' + id).update({ active: active }); });
    }
  };

  // ---- enrollments ---- (no table in legacy schema yet — v2 spec step 5)
  var enrollments = {
    listByStudent: notImplemented('enrollments.listByStudent', 'step 5'),
    create: notImplemented('enrollments.create', 'step 5'),
    end: notImplemented('enrollments.end', 'step 5')
  };

  // ---- sessions ----
  // A session doc is lazily created on first write (ensureSession), same as the
  // original single-file app did via commitField/commitSessionField.
  function ensureSession(classId, date){
    var id = sessionIdFor(classId, date);
    return need().then(function(raw){
      var ref = raw.doc('sessions/' + id);
      return ref.get().then(function(snap){
        if(snap.exists) return { ref: ref, id: id };
        var base = { classId: classId, date: date, topic: '', memo: '', createdAt: nowIso(), records: {} };
        return ref.set(base).then(function(){ return { ref: ref, id: id }; });
      });
    });
  }

  var sessions = {
    listByClass: function(classId, limit){
      return need().then(function(raw){
        return raw.collection('sessions').where('classId', '==', classId).orderBy('date', 'desc').limit(limit || 200).get()
          .then(function(snap){ return snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }); });
      });
    },
    // read-only: does NOT create a row. Returns a synthetic empty shell if none exists yet.
    getByDate: function(classId, date){
      var id = sessionIdFor(classId, date);
      return need().then(function(raw){
        return raw.doc('sessions/' + id).get().then(function(snap){
          if(snap.exists) return Object.assign({ id: id }, snap.data());
          return { id: id, classId: classId, date: date, topic: '', memo: '', records: {} };
        });
      });
    },
    create: function(classId, date, data){
      var id = sessionIdFor(classId, date);
      return need().then(function(raw){
        return raw.doc('sessions/' + id)
          .set(Object.assign({ classId: classId, date: date, topic: '', memo: '', createdAt: nowIso(), records: {} }, data))
          .then(function(){ return { id: id }; });
      });
    },
    // upsert-style: creates the session row on first call for this class+date.
    update: function(classId, date, fields){
      return ensureSession(classId, date).then(function(s){ return s.ref.update(fields); });
    }
  };

  // ---- attendance ---- (no table in legacy schema yet — v2 spec step 5/7)
  var attendance = {
    getBySession: function(){ return Promise.resolve([]); },
    upsertMany: notImplemented('attendance.upsertMany', 'step 7')
  };

  // ---- records ---- (legacy schema embeds records as a map on the session doc)
  var records = {
    getBySession: function(sessionId){
      return need().then(function(raw){
        return raw.doc('sessions/' + sessionId).get().then(function(snap){
          return snap.exists ? (snap.data().records || {}) : {};
        });
      });
    },
    // legacy shim needs classId explicitly (no enrollment table to join through yet).
    getByStudent: function(studentId, opts){
      var classId = opts && opts.classId;
      if(!classId) return Promise.reject(new Error('legacy adapter requires opts.classId for records.getByStudent'));
      return sessions.listByClass(classId).then(function(list){
        return list.filter(function(s){ return s.records && s.records[studentId]; })
          .map(function(s){ return { sessionId: s.id, date: s.date, topic: s.topic, record: s.records[studentId] }; });
      });
    },
    upsert: function(classId, date, studentId, fields){
      return ensureSession(classId, date).then(function(s){
        var payload = { records: {} };
        payload.records[studentId] = Object.assign({}, fields, { updatedAt: nowIso() });
        return s.ref.update(payload);
      });
    }
  };

  // ---- reports ---- (no table in legacy schema yet — v2 spec step 10)
  var reports = {
    getByStudent: function(){ return Promise.resolve([]); },
    create: notImplemented('reports.create', 'step 10'),
    update: notImplemented('reports.update', 'step 10')
  };

  return {
    ready: readyPromise,
    classes: classes,
    students: students,
    enrollments: enrollments,
    sessions: sessions,
    attendance: attendance,
    records: records,
    reports: reports
  };
}

export const db = ClaudeAdapter();
