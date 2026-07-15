/* ============================================================
   fieldform — offline-first form builder + data collection.
   No network. No dependencies. State in localStorage only.

   Two modes share one page:
     BUILD    — add/edit/reorder fields of several types.
     COLLECT  — fill the form; each save is a submission on-device.

   The form definition and all submissions can be exported (CSV/JSON)
   and the definition can be re-imported as a file — the offline
   handoff is EXPORT, never network sync. connect-src 'none' means
   this page cannot make a request even if it wanted to.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- tiny DOM helpers ---------- */
  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var FIELD_TYPES = {
    text:   { label: "Text",            hasOptions: false },
    number: { label: "Number",          hasOptions: false },
    single: { label: "Single choice",   hasOptions: true  },
    multi:  { label: "Multiple choice", hasOptions: true  },
    date:   { label: "Date",            hasOptions: false },
    yesno:  { label: "Yes / No",        hasOptions: false }
  };

  /* ============================================================
     PURE CORE (verified by throwaway node test)
     ============================================================ */

  // CSV cell escaping (RFC 4180): wrap in quotes if it contains comma,
  // quote, CR or LF; double any embedded quotes.
  function csvCell(value) {
    var s = value == null ? "" : String(value);
    if (/[",\r\n]/.test(s)) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // Build a CSV string from a header array and rows (array of arrays).
  // CRLF line endings per RFC 4180.
  function toCSV(header, rows) {
    var lines = [header.map(csvCell).join(",")];
    rows.forEach(function (row) { lines.push(row.map(csvCell).join(",")); });
    return lines.join("\r\n");
  }

  // A field's stored value -> a flat string for CSV / display.
  function valueToText(field, value) {
    if (value == null || value === "") return "";
    if (field.type === "multi") {
      if (Array.isArray(value)) return value.join("; ");
      return String(value);
    }
    if (field.type === "yesno") {
      return value === true || value === "yes" ? "Yes"
           : (value === false || value === "no" ? "No" : "");
    }
    return String(value);
  }

  // Required fields that are empty -> array of field ids (invalid).
  function findMissingRequired(fields, answers) {
    var missing = [];
    fields.forEach(function (f) {
      if (!f.required) return;
      var v = answers[f.id];
      var empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
      if (empty) missing.push(f.id);
    });
    return missing;
  }

  // Normalise a raw imported form-definition object, or null if invalid.
  function normalizeImportedForm(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.kind !== "fieldform.form") return null;
    if (!Array.isArray(raw.fields)) return null;
    var fields = [];
    for (var i = 0; i < raw.fields.length; i++) {
      var f = raw.fields[i];
      if (!f || typeof f !== "object") return null;
      if (!FIELD_TYPES[f.type]) return null;
      if (typeof f.label !== "string" || !f.label.trim()) return null;
      var nf = {
        id: typeof f.id === "string" && f.id ? f.id : ("f-" + i),
        type: f.type,
        label: f.label.trim(),
        required: f.required === true
      };
      if (FIELD_TYPES[f.type].hasOptions) {
        nf.options = Array.isArray(f.options)
          ? f.options.map(function (o) { return String(o); }).filter(function (o) { return o.trim() !== ""; })
          : [];
      }
      fields.push(nf);
    }
    return {
      kind: "fieldform.form",
      version: 1,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Imported form",
      fields: fields
    };
  }

  // Serialize a form to the export shape (what import consumes).
  function formToExport(form) {
    return {
      kind: "fieldform.form",
      version: 1,
      title: form.title,
      fields: form.fields.map(function (f) {
        var o = { id: f.id, type: f.type, label: f.label, required: !!f.required };
        if (FIELD_TYPES[f.type].hasOptions) o.options = (f.options || []).slice();
        return o;
      })
    };
  }

  /* ============================================================
     STATE + PERSISTENCE (localStorage only)
     ============================================================ */
  var STORE_KEY = "fieldform:v1";
  var storageOk = true;

  // state.forms: [{ id, title, fields:[...], submissions:[{ id, at, answers }] }]
  var state = { activeId: null, forms: [] };

  function uid() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  function save() {
    if (!storageOk) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { storageOk = false; showToast("Storage is full or blocked — export to keep your data."); }
  }

  function load() {
    try {
      localStorage.setItem("fieldform:test", "1");
      localStorage.removeItem("fieldform:test");
    } catch (e) { storageOk = false; }

    var raw = null;
    if (storageOk) { try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; } }
    if (raw) {
      try {
        var loaded = JSON.parse(raw);
        if (loaded && Array.isArray(loaded.forms)) state = loaded;
      } catch (e) { /* fall through to seed */ }
    }
    if (!state.forms.length) seed();
    if (!state.activeId || !formById(state.activeId)) state.activeId = state.forms[0].id;
  }

  // A friendly first-run form so the app is never a blank slate.
  function seed() {
    var g = {
      id: uid(),
      title: "Site survey",
      fields: [
        { id: uid(), type: "text",   label: "Plot ID", required: true },
        { id: uid(), type: "number", label: "Trees counted", required: false },
        { id: uid(), type: "single", label: "Canopy health", required: true, options: ["Good", "Fair", "Poor"] },
        { id: uid(), type: "multi",  label: "Signs observed", required: false, options: ["Deadwood", "Fungus", "Nesting", "Erosion"] },
        { id: uid(), type: "yesno",  label: "Access clear?", required: true },
        { id: uid(), type: "date",   label: "Date visited", required: false }
      ],
      submissions: []
    };
    state.forms = [g];
    state.activeId = g.id;
  }

  function formById(id) {
    for (var i = 0; i < state.forms.length; i++) if (state.forms[i].id === id) return state.forms[i];
    return null;
  }
  function activeForm() { return formById(state.activeId); }
  function fieldById(form, id) {
    for (var i = 0; i < form.fields.length; i++) if (form.fields[i].id === id) return form.fields[i];
    return null;
  }

  /* ============================================================
     RENDER — form selector
     ============================================================ */
  function renderFormSelect() {
    var sel = $("#formSelect");
    sel.innerHTML = "";
    state.forms.forEach(function (f) {
      var o = el("option", null, f.title);
      o.value = f.id;
      if (f.id === state.activeId) o.selected = true;
      sel.appendChild(o);
    });
    $("#deleteFormBtn").disabled = state.forms.length <= 1;
  }

  /* ============================================================
     RENDER — BUILD (field list)
     ============================================================ */
  var dragId = null;

  function renderFields() {
    var form = activeForm();
    var list = $("#fieldList");
    list.innerHTML = "";
    $("#fieldCount").textContent = String(form.fields.length);
    $("#fieldsEmpty").hidden = form.fields.length > 0;

    form.fields.forEach(function (f, idx) {
      var li = el("li", "fieldrow");
      li.setAttribute("data-id", f.id);

      // drag handle
      var handle = el("button", "fieldrow__handle");
      handle.type = "button";
      handle.setAttribute("aria-label", "Drag to reorder " + f.label);
      handle.textContent = "⠿";
      handle.setAttribute("draggable", "true");
      handle.addEventListener("dragstart", function (e) {
        dragId = f.id; li.classList.add("is-dragging");
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", f.id); } catch (er) {} }
      });
      handle.addEventListener("dragend", function () { dragId = null; li.classList.remove("is-dragging"); $$(".fieldrow").forEach(function (r) { r.classList.remove("is-over"); }); });
      li.appendChild(handle);

      // main: editable label + meta
      var main = el("div", "fieldrow__main");
      var lbl = el("input", "fieldrow__label");
      lbl.type = "text"; lbl.value = f.label; lbl.maxLength = 120;
      lbl.setAttribute("aria-label", "Edit label for this field");
      lbl.addEventListener("change", function () {
        var v = lbl.value.trim();
        if (v) { f.label = v; save(); renderCollect(); renderSubmissions(); }
        else { lbl.value = f.label; }
      });
      lbl.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); lbl.blur(); } });
      main.appendChild(lbl);

      var meta = el("div", "fieldrow__meta");
      meta.appendChild(el("span", "fieldrow__type", FIELD_TYPES[f.type].label));
      if (FIELD_TYPES[f.type].hasOptions) {
        var optText = (f.options && f.options.length) ? f.options.join(", ") : "no choices yet";
        var opts = el("span", "fieldrow__opts", optText);
        opts.title = optText;
        meta.appendChild(opts);
      }
      main.appendChild(meta);
      li.appendChild(main);

      // controls: required toggle, up, down, edit options (if any), delete
      var ctrls = el("div", "fieldrow__ctrls");

      var reqBtn = el("button", "fieldrow__reqbtn", "Req");
      reqBtn.type = "button";
      reqBtn.setAttribute("aria-pressed", f.required ? "true" : "false");
      reqBtn.setAttribute("aria-label", (f.required ? "Required — click to make optional" : "Optional — click to make required") + ": " + f.label);
      reqBtn.title = f.required ? "Required" : "Optional";
      reqBtn.addEventListener("click", function () {
        f.required = !f.required; save(); renderFields(); renderCollect();
      });
      ctrls.appendChild(reqBtn);

      var up = iconBtn("Move up", svgArrow("up"));
      up.disabled = idx === 0;
      up.addEventListener("click", function () { moveField(idx, idx - 1); });
      ctrls.appendChild(up);

      var down = iconBtn("Move down", svgArrow("down"));
      down.disabled = idx === form.fields.length - 1;
      down.addEventListener("click", function () { moveField(idx, idx + 1); });
      ctrls.appendChild(down);

      if (FIELD_TYPES[f.type].hasOptions) {
        var editOpt = iconBtn("Edit choices", svgPencil());
        editOpt.addEventListener("click", function () { editOptions(f.id); });
        ctrls.appendChild(editOpt);
      }

      var del = iconBtn("Delete " + f.label, svgTrash());
      del.className += " iconbtn--del";
      del.addEventListener("click", function () { deleteField(f.id); });
      ctrls.appendChild(del);

      li.appendChild(ctrls);

      // drop targets (whole row)
      li.addEventListener("dragover", function (e) {
        if (dragId == null || dragId === f.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        li.classList.add("is-over");
      });
      li.addEventListener("dragleave", function () { li.classList.remove("is-over"); });
      li.addEventListener("drop", function (e) {
        e.preventDefault();
        li.classList.remove("is-over");
        if (dragId == null || dragId === f.id) return;
        var from = indexOfField(dragId), to = indexOfField(f.id);
        if (from !== -1 && to !== -1) moveField(from, to);
      });

      list.appendChild(li);
    });
  }

  function iconBtn(label, svg) {
    var b = el("button", "iconbtn");
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.innerHTML = svg;
    return b;
  }
  function svgArrow(dir) {
    var d = dir === "up" ? "M12 5 L12 19 M12 5 L6 11 M12 5 L18 11" : "M12 19 L12 5 M12 19 L6 13 M12 19 L18 13";
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
  }
  function svgPencil() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  }
  function svgTrash() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
  }

  function indexOfField(id) {
    var form = activeForm();
    for (var i = 0; i < form.fields.length; i++) if (form.fields[i].id === id) return i;
    return -1;
  }
  function moveField(from, to) {
    var form = activeForm();
    if (to < 0 || to >= form.fields.length || from === to) return;
    var moved = form.fields.splice(from, 1)[0];
    form.fields.splice(to, 0, moved);
    save();
    renderFields();
    renderCollect();
  }
  function deleteField(id) {
    var form = activeForm();
    var f = fieldById(form, id);
    if (!f) return;
    if (!window.confirm("Delete the field “" + f.label + "”? Existing submissions keep their recorded answers.")) return;
    form.fields = form.fields.filter(function (x) { return x.id !== id; });
    save();
    renderFields();
    renderCollect();
    renderSubmissions();
  }
  function editOptions(id) {
    var form = activeForm();
    var f = fieldById(form, id);
    if (!f) return;
    var cur = (f.options || []).join("\n");
    var next = window.prompt("Choices for “" + f.label + "” — one per line:", cur);
    if (next == null) return;
    f.options = next.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s !== ""; });
    save();
    renderFields();
    renderCollect();
  }

  /* ============================================================
     ADD FIELD form
     ============================================================ */
  function onTypeChange() {
    var t = $("#newFieldType").value;
    $("#newFieldOptsWrap").hidden = !FIELD_TYPES[t].hasOptions;
  }

  function addField(e) {
    e.preventDefault();
    var errEl = $("#buildError");
    var label = $("#newFieldLabel").value.trim();
    var type = $("#newFieldType").value;
    var required = $("#newFieldRequired").checked;

    if (!label) { errEl.textContent = "Give the field a question or label."; return; }
    if (!FIELD_TYPES[type]) { errEl.textContent = "Choose a valid field type."; return; }

    var field = { id: uid(), type: type, label: label, required: required };
    if (FIELD_TYPES[type].hasOptions) {
      var opts = $("#newFieldOpts").value.split("\n")
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s !== ""; });
      if (!opts.length) { errEl.textContent = "Add at least one choice (one per line) for a choice field."; return; }
      field.options = opts;
    }
    errEl.textContent = "";

    activeForm().fields.push(field);
    save();

    // reset inputs for fast repeated entry
    $("#newFieldLabel").value = "";
    $("#newFieldOpts").value = "";
    $("#newFieldRequired").checked = false;

    renderFields();
    renderCollect();
    $("#newFieldLabel").focus();
    showToast("Field added");
  }

  /* ============================================================
     RENDER — COLLECT (data-entry form)
     ============================================================ */
  function renderCollect() {
    var form = activeForm();
    var wrap = $("#collectFields");
    wrap.innerHTML = "";

    var hasFields = form.fields.length > 0;
    $("#collectEmpty").hidden = hasFields;
    $("#collectActions").hidden = !hasFields;
    $("#collectError").textContent = "";

    form.fields.forEach(function (f) {
      var q = el("div", "qfield");
      q.setAttribute("data-id", f.id);

      var inputId = "c-" + f.id;
      var lab = el("label", "qfield__label");
      lab.setAttribute("for", inputId);
      lab.appendChild(document.createTextNode(f.label));
      if (f.required) {
        var star = el("span", "qfield__star", "*");
        star.setAttribute("aria-hidden", "true");
        lab.appendChild(star);
        lab.appendChild(el("span", "sr-only", "(required)"));
      }
      q.appendChild(lab);

      if (f.type === "text") {
        var ti = el("input", "input");
        ti.type = "text"; ti.id = inputId; ti.setAttribute("data-in", f.id);
        ti.autocomplete = "off"; ti.maxLength = 2000;
        if (f.required) ti.setAttribute("aria-required", "true");
        q.appendChild(ti);
      } else if (f.type === "number") {
        var ni = el("input", "input");
        ni.type = "text"; ni.inputMode = "decimal"; ni.id = inputId; ni.setAttribute("data-in", f.id);
        ni.autocomplete = "off"; ni.placeholder = "0";
        ni.setAttribute("aria-describedby", inputId + "-err");
        if (f.required) ni.setAttribute("aria-required", "true");
        q.appendChild(ni);
      } else if (f.type === "date") {
        var di = el("input", "input");
        di.type = "date"; di.id = inputId; di.setAttribute("data-in", f.id);
        if (f.required) di.setAttribute("aria-required", "true");
        q.appendChild(di);
      } else if (f.type === "yesno") {
        var yn = el("div", "yesno");
        yn.setAttribute("role", "radiogroup");
        yn.setAttribute("aria-label", f.label + (f.required ? " (required)" : ""));
        ["yes", "no"].forEach(function (val, i) {
          var opt = el("label", "yesno__opt" + (val === "no" ? " yesno__opt--no" : ""));
          var r = el("input"); r.type = "radio"; r.name = inputId; r.value = val;
          r.setAttribute("data-in", f.id);
          if (i === 0) r.id = inputId;
          opt.appendChild(r);
          opt.appendChild(el("span", null, val === "yes" ? "Yes" : "No"));
          yn.appendChild(opt);
        });
        q.appendChild(yn);
      } else if (f.type === "single" || f.type === "multi") {
        var group = el("div", "choices");
        group.setAttribute("role", f.type === "single" ? "radiogroup" : "group");
        group.setAttribute("aria-label", f.label + (f.required ? " (required)" : ""));
        (f.options || []).forEach(function (opt, i) {
          var c = el("label", "choice");
          var inp = el("input");
          inp.type = f.type === "single" ? "radio" : "checkbox";
          if (f.type === "single") inp.name = inputId;
          inp.value = opt;
          inp.setAttribute("data-in", f.id);
          if (i === 0) inp.id = inputId;
          c.appendChild(inp);
          c.appendChild(el("span", null, opt));
          group.appendChild(c);
        });
        if (!(f.options || []).length) {
          group.appendChild(el("span", "empty", "No choices set — edit this field on the left."));
        }
        q.appendChild(group);
      }

      var err = el("p", "qfield__err");
      err.id = inputId + "-err";
      err.setAttribute("aria-live", "polite");
      q.appendChild(err);

      wrap.appendChild(q);
    });
  }

  // Read every answer out of the collect form into a { fieldId: value } map.
  function readAnswers() {
    var form = activeForm();
    var answers = {};
    form.fields.forEach(function (f) {
      if (f.type === "multi") {
        var checked = $$('input[data-in="' + f.id + '"]:checked');
        answers[f.id] = checked.map(function (c) { return c.value; });
      } else if (f.type === "single" || f.type === "yesno") {
        var one = $('input[data-in="' + f.id + '"]:checked');
        answers[f.id] = one ? one.value : "";
      } else {
        var input = $('[data-in="' + f.id + '"]');
        answers[f.id] = input ? input.value.trim() : "";
      }
    });
    return answers;
  }

  function clearInvalid() {
    $$("#collectFields .qfield").forEach(function (q) {
      q.classList.remove("is-invalid");
      var e = $(".qfield__err", q);
      if (e) e.textContent = "";
    });
  }

  function saveEntry(e) {
    e.preventDefault();
    var form = activeForm();
    var errEl = $("#collectError");
    clearInvalid();

    if (!form.fields.length) { errEl.textContent = "Add a field to the form first."; return; }

    var answers = readAnswers();
    var missing = findMissingRequired(form.fields, answers);

    // number validation: any number field with a value must parse
    var badNumbers = [];
    form.fields.forEach(function (f) {
      if (f.type !== "number") return;
      var v = answers[f.id];
      if (v === "" || v == null) return;
      if (isNaN(Number(v))) badNumbers.push(f.id);
    });

    if (missing.length || badNumbers.length) {
      var firstBad = null;
      missing.forEach(function (id) {
        var q = $('#collectFields .qfield[data-id="' + id + '"]');
        if (q) { q.classList.add("is-invalid"); var em = $(".qfield__err", q); if (em) em.textContent = "This field is required."; if (!firstBad) firstBad = q; }
      });
      badNumbers.forEach(function (id) {
        var q = $('#collectFields .qfield[data-id="' + id + '"]');
        if (q) { q.classList.add("is-invalid"); var em = $(".qfield__err", q); if (em) em.textContent = "Enter a valid number."; if (!firstBad) firstBad = q; }
      });
      errEl.textContent = missing.length
        ? "Fill in the required field" + (missing.length > 1 ? "s" : "") + " marked below."
        : "Fix the number field" + (badNumbers.length > 1 ? "s" : "") + " marked below.";
      if (firstBad) {
        var focusable = $("input, select, textarea", firstBad);
        if (focusable && focusable.focus) focusable.focus();
      }
      return;
    }

    errEl.textContent = "";
    form.submissions.push({ id: uid(), at: Date.now(), answers: answers });
    save();
    clearEntry();
    renderSubmissions();
    showToast("Entry saved — " + form.submissions.length + " on this device");
  }

  function clearEntry() {
    clearInvalid();
    $("#collectError").textContent = "";
    renderCollect();
  }

  /* ============================================================
     RENDER — SUBMISSIONS
     ============================================================ */
  function renderSubmissions() {
    var form = activeForm();
    var list = $("#subList");
    list.innerHTML = "";
    var subs = form.submissions || [];
    $("#subCount").textContent = String(subs.length);
    $("#subsEmpty").hidden = subs.length > 0;
    $("#exportBar").hidden = subs.length === 0;

    // newest first
    subs.slice().reverse().forEach(function (sub, revIdx) {
      var num = subs.length - revIdx;
      var li = el("li", "sub");

      li.appendChild(el("span", "sub__no", "#" + num));
      li.appendChild(el("span", "sub__when", formatWhen(sub.at)));

      // summary: first two non-empty answers
      var summary = el("span", "sub__summary");
      var shown = 0;
      form.fields.forEach(function (f) {
        if (shown >= 2) return;
        var txt = valueToText(f, sub.answers[f.id]);
        if (!txt) return;
        if (shown > 0) summary.appendChild(document.createTextNode(" · "));
        var strong = el("strong", null, f.label + ": ");
        summary.appendChild(strong);
        summary.appendChild(document.createTextNode(clip(txt, 40)));
        shown++;
      });
      if (shown === 0) summary.appendChild(document.createTextNode("(empty entry)"));
      li.appendChild(summary);

      var del = el("button", "sub__del", "Delete");
      del.type = "button";
      del.setAttribute("aria-label", "Delete submission #" + num);
      del.addEventListener("click", function () { deleteSubmission(sub.id); });
      li.appendChild(del);

      list.appendChild(li);
    });
  }

  function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  function formatWhen(ts) {
    try {
      var d = new Date(ts);
      return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return new Date(ts).toISOString(); }
  }

  function deleteSubmission(id) {
    var form = activeForm();
    form.submissions = form.submissions.filter(function (s) { return s.id !== id; });
    save();
    renderSubmissions();
    showToast("Submission deleted");
  }

  function clearSubmissions() {
    var form = activeForm();
    if (!form.submissions.length) return;
    if (!window.confirm("Delete all " + form.submissions.length + " submission(s) for “" + form.title + "”? Export them first if you need them. This can't be undone.")) return;
    form.submissions = [];
    save();
    renderSubmissions();
    showToast("All submissions deleted");
  }

  /* ============================================================
     EXPORT — submissions to CSV / JSON, form def to JSON
     ============================================================ */
  function slug(s) {
    return (s || "form").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "form";
  }
  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }

  // Trigger a download from an in-memory string. Uses a Blob object URL,
  // which is created and revoked locally — no network involved.
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = el("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function exportCsv() {
    var form = activeForm();
    var subs = form.submissions || [];
    if (!subs.length) { showToast("No submissions to export"); return; }
    var header = ["#", "Saved at"].concat(form.fields.map(function (f) { return f.label; }));
    var rows = subs.map(function (sub, i) {
      var row = [String(i + 1), new Date(sub.at).toISOString()];
      form.fields.forEach(function (f) { row.push(valueToText(f, sub.answers[f.id])); });
      return row;
    });
    // BOM so Excel reads UTF-8 correctly.
    download(slug(form.title) + "-" + stamp() + ".csv", "﻿" + toCSV(header, rows), "text/csv");
    showToast("Exported " + subs.length + " row" + (subs.length > 1 ? "s" : "") + " to CSV");
  }

  function exportJson() {
    var form = activeForm();
    var subs = form.submissions || [];
    if (!subs.length) { showToast("No submissions to export"); return; }
    var out = {
      kind: "fieldform.data",
      version: 1,
      exportedAt: new Date().toISOString(),
      form: formToExport(form),
      submissions: subs.map(function (sub) {
        return { id: sub.id, at: new Date(sub.at).toISOString(), answers: sub.answers };
      })
    };
    download(slug(form.title) + "-" + stamp() + ".json", JSON.stringify(out, null, 2), "application/json");
    showToast("Exported " + subs.length + " submission" + (subs.length > 1 ? "s" : "") + " to JSON");
  }

  function exportForm() {
    var form = activeForm();
    download(slug(form.title) + "-form.json", JSON.stringify(formToExport(form), null, 2), "application/json");
    showToast("Form definition exported — share the file");
  }

  /* ============================================================
     IMPORT — a form definition file
     ============================================================ */
  function onImportFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();   // reads the local file only; no network
    reader.onload = function () {
      var text = String(reader.result || "");
      var raw = null;
      try { raw = JSON.parse(text); } catch (err) { showToast("That file isn't valid JSON."); resetImportInput(); return; }
      // Accept either a bare form definition or a full data export.
      var candidate = raw && raw.kind === "fieldform.data" && raw.form ? raw.form : raw;
      var form = normalizeImportedForm(candidate);
      if (!form) { showToast("That doesn't look like a fieldform form file."); resetImportInput(); return; }
      var newForm = {
        id: uid(),
        title: form.title,
        fields: form.fields.map(function (f) {
          var nf = { id: uid(), type: f.type, label: f.label, required: f.required };
          if (FIELD_TYPES[f.type].hasOptions) nf.options = (f.options || []).slice();
          return nf;
        }),
        submissions: []
      };
      state.forms.push(newForm);
      state.activeId = newForm.id;
      save();
      renderAll();
      showToast("Imported “" + form.title + "” — " + form.fields.length + " field" + (form.fields.length !== 1 ? "s" : ""));
      resetImportInput();
    };
    reader.onerror = function () { showToast("Couldn't read that file."); resetImportInput(); };
    reader.readAsText(file);
  }
  function resetImportInput() { var i = $("#importFormInput"); if (i) i.value = ""; }

  /* ============================================================
     FORMS — new / rename / delete / switch
     ============================================================ */
  function newForm() {
    var title = window.prompt("Name this form (e.g. “Water sampling”, “Household census”):", "");
    if (title == null) return;
    title = title.trim();
    if (!title) return;
    var f = { id: uid(), title: title, fields: [], submissions: [] };
    state.forms.push(f);
    state.activeId = f.id;
    save();
    renderAll();
    $("#newFieldLabel").focus();
  }
  function renameForm() {
    var form = activeForm();
    var title = window.prompt("Rename this form:", form.title);
    if (title == null) return;
    title = title.trim();
    if (!title) return;
    form.title = title;
    save();
    renderAll();
  }
  function deleteForm() {
    if (state.forms.length <= 1) return;
    var form = activeForm();
    var n = form.submissions.length;
    if (!window.confirm("Delete the form “" + form.title + "”" + (n ? " and its " + n + " submission(s)" : "") + "? Export first if you need the data. This can't be undone.")) return;
    state.forms = state.forms.filter(function (x) { return x.id !== form.id; });
    state.activeId = state.forms[0].id;
    save();
    renderAll();
  }
  function switchForm(id) {
    if (!formById(id)) return;
    state.activeId = id;
    save();
    renderAll();
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function showToast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ============================================================
     RENDER ALL
     ============================================================ */
  function renderAll() {
    renderFormSelect();
    renderFields();
    renderCollect();
    renderSubmissions();
  }

  /* ============================================================
     WIRE UP
     ============================================================ */
  function init() {
    load();

    $("#addFieldForm").addEventListener("submit", addField);
    $("#newFieldType").addEventListener("change", onTypeChange);
    onTypeChange();

    $("#collectForm").addEventListener("submit", saveEntry);
    $("#clearEntryBtn").addEventListener("click", clearEntry);

    $("#newFormBtn").addEventListener("click", newForm);
    $("#renameFormBtn").addEventListener("click", renameForm);
    $("#deleteFormBtn").addEventListener("click", deleteForm);
    $("#formSelect").addEventListener("change", function () { switchForm(this.value); });

    $("#exportFormBtn").addEventListener("click", exportForm);
    $("#importFormBtn").addEventListener("click", function () { $("#importFormInput").click(); });
    $("#importFormInput").addEventListener("change", onImportFile);

    $("#exportCsvBtn").addEventListener("click", exportCsv);
    $("#exportJsonBtn").addEventListener("click", exportJson);
    $("#clearSubsBtn").addEventListener("click", clearSubmissions);

    renderAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
