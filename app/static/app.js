/* Nexora — lógica del frontend. Vanilla JS sobre la API REST + WebSocket. */
(function () {
  "use strict";

  // ---- utilidades ------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function svg(p) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + p + "</svg>"; }
  var ICON = {
    play: '<path d="M7 5l12 7-12 7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    reboot: '<path d="M3 12a9 9 0 019-9 9 9 0 018 5M21 12a9 9 0 01-9 9 9 9 0 01-8-5"/><path d="M21 4v4h-4M3 20v-4h4"/>',
    force: '<path d="M18.4 5.6a9 9 0 11-12.8 0M12 2v8"/>',
    pause: '<path d="M6 4v16M20 4v16M6 12h14"/>',
    term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
    power: '<path d="M12 3v9M18.4 6.6a9 9 0 11-12.8 0"/>',
    grow: '<path d="M15 3h6v6M10 14L21 3M9 21H3v-6M3 21l7-7"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  var TY = { kvm: ["b-kvm", "KVM"], docker: ["b-docker", "Docker"], lxc: ["b-lxc", "LXC"] };
  var ST = {
    run: ["p-run", "en marcha", "s-run"],
    stop: ["p-stop", "detenida", "s-stop"],
    pause: ["p-pause", "pausada", "s-pause"],
    unknown: ["p-unknown", "desconocido", "s-unknown"],
  };
  function st(s) { return ST[s] || ST.unknown; }
  function ty(t) { return TY[t] || ["", t]; }

  async function api(path, options) {
    var res = await fetch(path, options);
    var data = null;
    try { data = await res.json(); } catch (e) { /* vacío */ }
    if (!res.ok) {
      var detail = (data && data.detail) || res.statusText || "Error";
      throw new Error(detail);
    }
    return data;
  }

  function toast(msg, kind) {
    var box = document.getElementById("toasts");
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }

  // ---- estado global ---------------------------------------------------
  var machines = [];
  var modules = [];
  var netsData = [];
  var netMode = "create";
  var netEditTarget = null;
  var currentMachine = null;   // ficha abierta ahora mismo
  var diskTarget = null;       // disco que se está redimensionando
  var pendingNetKey = null;    // red a resaltar al abrir la vista Redes

  // ---- navegación entre vistas ----------------------------------------
  var VIEWS = ["maquinas", "ficha", "redes", "consola"];
  var TITLES = { maquinas: "Máquinas", ficha: "Ficha de máquina", redes: "Redes", consola: "Consola" };
  function show(v) {
    if (VIEWS.indexOf(v) < 0) v = "maquinas";
    document.querySelectorAll("section.view").forEach(function (s) {
      s.hidden = s.getAttribute("data-view") !== v;
    });
    document.querySelectorAll(".nav[data-view]").forEach(function (n) {
      n.setAttribute("aria-current", n.getAttribute("data-view") === v ? "true" : "false");
    });
    var t = document.getElementById("viewtitle");
    if (TITLES[v]) t.textContent = TITLES[v];
    try { location.hash = v; } catch (e) {}
    if (v === "redes") loadNetworks();
    if (v === "consola") fillConsoleSelect();
    window.scrollTo(0, 0);
  }
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-view]");
    if (el && !el.classList.contains("view")) { e.preventDefault(); show(el.getAttribute("data-view")); }
    var soon = e.target.closest && e.target.closest("[data-soon]");
    if (soon) { toast(soon.getAttribute("data-soon")); }
  });

  // ---- máquinas: carga y render ---------------------------------------
  function moduleSelect(current) {
    var opts = modules.map(function (m) { return m.name; });
    var html = '<select class="modsel" aria-label="Módulo">';
    html += '<option value=""' + (!current ? " selected" : "") + ">— sin módulo —</option>";
    opts.forEach(function (name) {
      html += "<option" + (name === current ? " selected" : "") + ">" + esc(name) + "</option>";
    });
    html += "</select>";
    return html;
  }

  function renderRows() {
    var tbody = document.getElementById("mrows");
    tbody.innerHTML = machines.map(function (m) {
      var t = ty(m.type), s = st(m.state);
      var search = [m.name, m.ip, m.description, m.module, (m.tags || []).join(" ")].join(" ").toLowerCase();
      var playStop = m.state === "run"
        ? '<button class="iact" title="Apagar" data-act="stop">' + svg(ICON.stop) + "</button>" +
          '<button class="iact" title="Reiniciar" data-act="reboot">' + svg(ICON.reboot) + "</button>"
        : '<button class="iact" title="Arrancar" data-act="start">' + svg(ICON.play) + "</button>";
      return '<tr data-id="' + esc(m.id) + '" data-type="' + esc(m.type) + '" data-state="' + esc(m.state) +
        '" data-module="' + esc(m.module || "") + '" data-search="' + esc(search) + '">' +
        '<td><div class="mbig"><span class="sdot ' + s[2] + '" title="' + s[1] + '"></span>' + esc(m.name) + "</div></td>" +
        '<td><span class="badge ' + t[0] + '">' + t[1] + "</span></td>" +
        '<td class="num">' + esc(m.vcpus) + "</td>" +
        '<td class="num">' + esc(m.memory) + "</td>" +
        '<td class="mono">' + esc(m.ip) + "</td>" +
        '<td class="mdesc">' + esc(m.description || "") + "</td>" +
        "<td>" + moduleSelect(m.module) + "</td>" +
        '<td><div class="rowacts">' + playStop +
        '<button class="iact" title="Consola" data-act="console">' + svg(ICON.term) + "</button></div></td>" +
        "</tr>";
    }).join("");
    applyFilters();
  }

  function renderCounts(metrics) {
    var total = machines.length;
    var run = machines.filter(function (m) { return m.state === "run"; }).length;
    var kvm = machines.filter(function (m) { return m.type === "kvm"; }).length;
    var dk = machines.filter(function (m) { return m.type === "docker"; }).length;
    var lx = machines.filter(function (m) { return m.type === "lxc"; }).length;
    document.getElementById("navcount").textContent = total;

    function box(v, label) { return '<div class="card countbox"><div class="cv num">' + v + "</div>" + label + "</div>"; }
    document.getElementById("maqcounts").innerHTML =
      box(total, '<span class="cl">máquinas</span>') +
      box('<span style="color:var(--ok)">' + run + "</span>", '<span class="cl">encendidas</span>') +
      box(kvm, '<span class="cl"><span class="badge b-kvm">KVM</span></span>') +
      box(dk, '<span class="cl"><span class="badge b-docker">Docker</span></span>') +
      box(lx, '<span class="cl"><span class="badge b-lxc">LXC</span></span>');

    var el = document.getElementById("maqmetrics");
    if (!metrics || !metrics.available) { el.innerHTML = ""; return; }
    function card(lbl, val, unit, pct, color, foot) {
      return '<div class="card tile"><div class="lbl">' + lbl + "</div>" +
        '<div class="big num">' + val + "<small>" + unit + "</small></div>" +
        '<div class="meter"><i style="width:' + Math.min(pct, 100) + "%;background:" + color + '"></i></div>' +
        '<div class="foot">' + foot + "</div></div>";
    }
    el.innerHTML =
      card("RAM del host", metrics.mem_used_gib, " / " + metrics.mem_total_gib + " GiB", metrics.mem_percent,
        metrics.mem_percent > 85 ? "var(--crit)" : "var(--warn)", metrics.mem_percent + "% en uso") +
      card("Carga de CPU", metrics.cpu_percent, "% · " + metrics.cpu_count + " CPU", metrics.cpu_percent,
        "var(--accent)", "carga 1m · " + metrics.load1) +
      card("Disco /", metrics.disk_used_gib, " / " + metrics.disk_total_gib + " GiB", metrics.disk_percent,
        metrics.disk_percent > 85 ? "var(--crit)" : "var(--ok)", metrics.disk_percent + "% en uso");
  }

  function renderModuleChips() {
    var wrap = document.getElementById("modulofilter");
    var html = '<span class="flabel">Módulo</span><button class="chip" data-k="all" aria-pressed="true">Todos</button>';
    modules.forEach(function (m) {
      html += '<button class="chip" data-k="' + esc(m.name) + '">' + esc(m.name) + "</button>";
    });
    html += '<button class="chip" data-k="__none__">Sin módulo</button>';
    wrap.innerHTML = html;
  }

  async function loadMachines() {
    try {
      var results = await Promise.all([api("/api/machines"), api("/api/metrics").catch(function () { return null; })]);
      machines = results[0] || [];
      renderCounts(results[1]);
      renderRows();
    } catch (e) {
      toast("No se pudieron cargar las máquinas: " + e.message, "err");
    }
  }

  // ---- filtros ---------------------------------------------------------
  function activeChip(id) {
    var g = document.getElementById(id);
    var b = g && g.querySelector('button[aria-pressed="true"]');
    return b ? b.getAttribute("data-k") : "all";
  }
  function applyFilters() {
    var tbody = document.getElementById("mrows");
    var q = (document.getElementById("maqsearch").value || "").trim().toLowerCase();
    var est = document.getElementById("estadosel").value;
    var tip = activeChip("tipofilter");
    var mod = activeChip("modulofilter");
    var shown = 0;
    tbody.querySelectorAll("tr").forEach(function (tr) {
      var okQ = !q || (tr.getAttribute("data-search") || "").indexOf(q) >= 0;
      var okE = est === "all" || tr.getAttribute("data-state") === est;
      var okT = tip === "all" || tr.getAttribute("data-type") === tip;
      var dmod = tr.getAttribute("data-module") || "";
      var okM = mod === "all" || (mod === "__none__" ? dmod === "" : dmod === mod);
      var vis = okQ && okE && okT && okM;
      tr.hidden = !vis; if (vis) shown++;
    });
    document.getElementById("maqempty").hidden = shown > 0;
  }
  function wireChips(id) {
    document.getElementById(id).addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      this.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      applyFilters();
    });
  }

  // ---- acciones sobre filas -------------------------------------------
  async function doAction(id, op) {
    try {
      await api("/api/machines/" + encodeURIComponent(id) + "/action", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: op }),
      });
      toast("Orden enviada: " + op, "ok");
      setTimeout(loadMachines, 600);
    } catch (e) {
      toast("Error: " + e.message, "err");
    }
  }
  async function patchModule(id, value) {
    try {
      await api("/api/machines/" + encodeURIComponent(id), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ module: value }),
      });
      var m = machines.filter(function (x) { return x.id === id; })[0];
      if (m) m.module = value;
      toast("Módulo actualizado", "ok");
      applyFilters();
    } catch (e) {
      toast("Error: " + e.message, "err");
    }
  }

  document.getElementById("mrows").addEventListener("change", function (e) {
    var sel = e.target.closest(".modsel"); if (!sel) return;
    var tr = e.target.closest("tr");
    tr.setAttribute("data-module", sel.value);
    patchModule(tr.getAttribute("data-id"), sel.value);
  });
  document.getElementById("mrows").addEventListener("click", function (e) {
    if (e.target.closest(".modsel")) return;
    var tr = e.target.closest("tr"); if (!tr) return;
    var id = tr.getAttribute("data-id");
    var actBtn = e.target.closest("[data-act]");
    if (actBtn) {
      e.stopPropagation();
      var act = actBtn.getAttribute("data-act");
      if (act === "console") { openConsole(id); return; }
      doAction(id, act);
      return;
    }
    openFicha(id);
  });

  // ---- ficha -----------------------------------------------------------
  async function openFicha(id) {
    show("ficha");
    var body = document.getElementById("fichaBody");
    body.innerHTML = '<p class="muted">Cargando ficha…</p>';
    try {
      var results = await Promise.all([
        api("/api/machines/" + encodeURIComponent(id)),
        api("/api/networks").catch(function () { return []; }),
      ]);
      var d = results[0];
      d._networks = (results[1] || []).filter(function (n) {
        return (n.machines || []).some(function (m) { return m.type + ":" + m.name === d.id; });
      });
      d._kvmnets = (results[1] || []).filter(function (n) { return n.backend === "kvm"; });
      renderFicha(d);
    } catch (e) {
      body.innerHTML = '<p class="errline">No se pudo cargar la ficha: ' + esc(e.message) + "</p>";
    }
  }

  function lifecycleButtons(d) {
    var on = d.state === "run", paused = d.state === "pause";
    var btns = [];
    if (!on && !paused) btns.push(["start", "Arrancar", ICON.play, ""]);
    if (on) btns.push(["stop", "Apagar", ICON.stop, ""]);
    if (on) btns.push(["reboot", "Reiniciar", ICON.reboot, ""]);
    if (paused) btns.push(["resume", "Reanudar", ICON.play, ""]);
    if (on) btns.push(["pause", "Pausar", ICON.pause, ""]);
    if (on || paused) btns.push(["forceoff", "Forzar apagado", ICON.force, "danger"]);
    var html = btns.map(function (b) {
      return '<button class="tbtn sm ' + b[3] + '" data-fichaact="' + b[0] + '">' + svg(b[2]) + b[1] + "</button>";
    }).join("");
    html += '<span class="spacer"></span>';
    if (d.type === "kvm") {
      html += '<button class="tbtn sm" data-resources="1">' + svg(ICON.cpu) + "Recursos</button>";
    }
    html += '<button class="tbtn sm" data-console="1">' + svg(ICON.term) + "Consola</button>";
    return html;
  }

  function renderFicha(d) {
    currentMachine = d;
    var t = ty(d.type), s = st(d.state);
    var html = "";
    html += '<div class="detailtop"><h2 id="fichaName">' + esc(d.name) + "</h2>" +
      '<span class="badge ' + t[0] + '">' + t[1] + "</span>" +
      (d.module ? '<span class="tag" style="background:var(--surface-2);color:var(--ink-2)">' + esc(d.module) + "</span>" : "") +
      '<span class="pill ' + s[0] + '"><span class="dot"></span>' + s[1] + "</span></div>";
    html += '<div class="lifecycle" data-id="' + esc(d.id) + '">' + lifecycleButtons(d) + "</div>";

    html += '<div class="detail"><div class="col">';
    // Descripción y notas (editable al pinchar)
    html += '<div class="card" id="metaCard"><div class="panel-h"><h3>Descripción y notas</h3>' +
      '<button class="tbtn sm" data-meta-edit="1">' + svg(ICON.edit) + "Editar</button></div>" +
      '<div class="panel-b" id="metaBody">' + metaDisplayHtml(d) + "</div></div>";
    // Usuarios
    html += '<div class="card"><div class="panel-h"><h3>Usuarios <span class="mono" style="font-weight:400;color:var(--ink-3)">/etc/passwd</span></h3>' +
      '<button class="tbtn sm" data-users="' + esc(d.id) + '">Cargar</button></div>' +
      '<div class="panel-b" id="usersBox"><p class="muted">Pulsa «Cargar» para leer los usuarios dentro de la máquina.</p></div></div>';
    html += "</div><div class='col'>";
    // Recursos / características según backend
    var kv = [["vCPU", d.vcpus], ["Memoria", d.memory], ["IP", d.ip], ["Arranque automático", d.autostart ? "sí" : "no"]];
    if (d.type === "kvm") {
      kv.push(["Arquitectura", d.arch], ["Máquina", d.machine_type], ["Firmware", d.firmware]);
      if (d.graphics) kv.push(["Pantalla", (d.graphics.type || "") + " · puerto " + (d.graphics.port || "")]);
      if (d.uuid) kv.push(["UUID", d.uuid]);
    } else if (d.type === "docker") {
      kv.push(["Imagen", d.image], ["Política reinicio", d.restart_policy]);
      if (d.ports && d.ports.length) kv.push(["Puertos", d.ports.join(", ")]);
    }
    html += card("Características", '<dl class="kv">' + kv.map(function (p) {
      return "<dt>" + esc(p[0]) + "</dt><dd>" + esc(p[1] || "—") + "</dd>";
    }).join("") + "</dl>");
    // Discos (KVM)
    if (d.type === "kvm" || (d.disks && d.disks.length)) {
      var diskRows = (d.disks && d.disks.length)
        ? d.disks.map(function (dk) {
          var meta = esc(dk.device) + (dk.format ? " · " + esc(dk.format) : "") +
            (dk.capacity && dk.capacity !== "—" ? " · " + esc(dk.capacity) : "");
          var canResize = dk.device === "disk" && d.type === "kvm";
          var right = '<span class="mono res" style="max-width:190px;overflow:hidden;text-overflow:ellipsis">' + esc(dk.source) + "</span>";
          if (canResize) {
            right += '<button class="tbtn sm" data-disk-resize="' + esc(dk.dev) +
              '" data-disk-cap="' + esc(dk.capacity_bytes || 0) + '">' + svg(ICON.grow) + "Agrandar</button>";
          }
          return '<div class="listrow"><span><span class="nm">' + esc(dk.dev) + "</span> " +
            '<span class="meta">· ' + meta + "</span></span>" +
            '<span class="right rowend">' + right + "</span></div>";
        }).join("")
        : '<p class="muted">Sin discos.</p>';
      var diskHead = d.type === "kvm"
        ? '<button class="tbtn sm" data-disk-add="1">' + svg(ICON.plus) + "Añadir disco</button>"
        : "";
      html += '<div class="card"><div class="panel-h"><h3>Discos</h3>' + diskHead +
        '</div><div class="panel-b">' + diskRows + "</div></div>";
    }
    // Interfaces
    if (d.type === "kvm" || (d.nics && d.nics.length)) {
      var nicRows = (d.nics && d.nics.length)
        ? d.nics.map(function (n) {
          var right = '<span class="mono res">' + esc(n.ip || "") + "</span>";
          if (d.type === "kvm" && n.mac) {
            right += '<button class="iact danger" title="Quitar interfaz" data-nic-del="' +
              esc(n.mac) + '">' + svg(ICON.trash) + "</button>";
          }
          return '<div class="listrow"><span><span class="nm">' + esc(n.network || "—") + "</span> " +
            '<span class="meta mono">' + esc(n.mac || "") + "</span></span>" +
            '<span class="right rowend">' + right + "</span></div>";
        }).join("")
        : '<p class="muted">Sin interfaces de red.</p>';
      var nicHead = d.type === "kvm"
        ? '<button class="tbtn sm" data-nic-add="1">' + svg(ICON.plus) + "Añadir interfaz</button>"
        : "";
      html += '<div class="card"><div class="panel-h"><h3>Interfaces de red</h3>' + nicHead +
        '</div><div class="panel-b">' + nicRows + "</div></div>";
    }
    // Redes que usa la máquina
    if (d._networks && d._networks.length) {
      html += card("Redes que usa", d._networks.map(function (n) {
        var mine = (n.machines || []).filter(function (m) { return m.type + ":" + m.name === d.id; })[0];
        var ip = mine && mine.ip ? mine.ip : "";
        var t = ty(n.backend);
        var meta = esc(n.mode) + (n.cidr && n.cidr !== "—" ? " · " + esc(n.cidr) : "");
        return '<div class="listrow link" data-net-goto="' + esc(n.backend + "|" + n.name) +
          '" title="Ir a la gestión de la red ' + esc(n.name) + '">' +
          '<span class="badge ' + t[0] + '">' + t[1] + "</span>" +
          '<span><span class="nm">' + esc(n.name) + '</span> <span class="meta">· ' + meta + "</span></span>" +
          '<span class="right mono res">' + esc(ip) + "</span>" +
          '<span class="chev">' + svg('<path d="M9 18l6-6-6-6"/>') + "</span></div>";
      }).join(""));
    }
    html += "</div></div>";
    document.getElementById("fichaBody").innerHTML = html;
  }

  function card(title, inner) {
    return '<div class="card"><div class="panel-h"><h3>' + title + '</h3></div><div class="panel-b">' + inner + "</div></div>";
  }

  // ---- descripción y notas: edición en línea --------------------------
  function metaDisplayHtml(d) {
    var inner =
      (d.description ? "<p>" + esc(d.description) + "</p>" : '<p class="muted">Sin descripción.</p>') +
      (d.notes ? '<div class="md">' + esc(d.notes) + "</div>" : "") +
      ((d.tags && d.tags.length) ? '<div class="taglist" style="margin-top:10px">' +
        d.tags.map(function (x) { return '<span class="tag" style="background:var(--surface-2);color:var(--ink-2)">' + esc(x) + "</span>"; }).join("") +
        "</div>" : "");
    return '<div class="meta-display" data-meta-edit="1" title="Pulsa para escribir">' + inner + "</div>";
  }
  function metaEditHtml(d) {
    return '<div class="field"><label>Descripción</label>' +
      '<textarea id="meta-desc" rows="2" placeholder="Para qué es esta máquina…">' + esc(d.description || "") + "</textarea></div>" +
      '<div class="field"><label>Notas</label>' +
      '<textarea id="meta-notes" rows="5" placeholder="Apuntes, credenciales de prácticas, pasos…">' + esc(d.notes || "") + "</textarea></div>" +
      '<div class="meta-actions"><button class="tbtn sm" data-meta-cancel="1">Cancelar</button>' +
      '<button class="tbtn sm primary" data-meta-save="1">Guardar</button></div>';
  }
  function enterMetaEdit() {
    if (!currentMachine) return;
    var body = document.getElementById("metaBody");
    if (!body) return;
    body.innerHTML = metaEditHtml(currentMachine);
    var ta = document.getElementById("meta-desc");
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
  function cancelMetaEdit() {
    var body = document.getElementById("metaBody");
    if (body && currentMachine) body.innerHTML = metaDisplayHtml(currentMachine);
  }
  async function saveMeta() {
    if (!currentMachine) return;
    var desc = (document.getElementById("meta-desc") || {}).value || "";
    var notes = (document.getElementById("meta-notes") || {}).value || "";
    try {
      await api("/api/machines/" + encodeURIComponent(currentMachine.id), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: desc, notes: notes }),
      });
      currentMachine.description = desc;
      currentMachine.notes = notes;
      var m = machines.filter(function (x) { return x.id === currentMachine.id; })[0];
      if (m) { m.description = desc; m.notes = notes; }
      var body = document.getElementById("metaBody");
      if (body) body.innerHTML = metaDisplayHtml(currentMachine);
      toast("Descripción y notas guardadas", "ok");
    } catch (e) {
      toast("Error: " + e.message, "err");
    }
  }

  document.getElementById("fichaBody").addEventListener("click", function (e) {
    var id = (e.target.closest(".lifecycle") || {}).getAttribute ? e.target.closest(".lifecycle").getAttribute("data-id") : null;
    var act = e.target.closest("[data-fichaact]");
    if (act && id) { doAction(id, act.getAttribute("data-fichaact")); setTimeout(function () { openFicha(id); }, 800); return; }
    if (e.target.closest("[data-console]") && id) { openConsole(id); return; }
    if (e.target.closest("[data-resources]")) { openResources(); return; }
    if (e.target.closest("[data-meta-edit]")) { enterMetaEdit(); return; }
    if (e.target.closest("[data-meta-cancel]")) { cancelMetaEdit(); return; }
    if (e.target.closest("[data-meta-save]")) { saveMeta(); return; }
    var resize = e.target.closest("[data-disk-resize]");
    if (resize) {
      openDiskResize(resize.getAttribute("data-disk-resize"),
        parseInt(resize.getAttribute("data-disk-cap"), 10) || 0);
      return;
    }
    if (e.target.closest("[data-disk-add]")) { openDiskAdd(); return; }
    if (e.target.closest("[data-nic-add]")) { openNicModal(); return; }
    var nicdel = e.target.closest("[data-nic-del]");
    if (nicdel) { deleteNic(nicdel.getAttribute("data-nic-del")); return; }
    var netgoto = e.target.closest("[data-net-goto]");
    if (netgoto) { gotoNetwork(netgoto.getAttribute("data-net-goto")); return; }
    var users = e.target.closest("[data-users]");
    if (users) { loadUsers(users.getAttribute("data-users")); }
  });

  async function loadUsers(id) {
    var boxEl = document.getElementById("usersBox");
    boxEl.innerHTML = '<p class="muted">Leyendo /etc/passwd…</p>';
    try {
      var users = await api("/api/machines/" + encodeURIComponent(id) + "/users");
      if (!users.length) { boxEl.innerHTML = '<p class="muted">Sin usuarios.</p>'; return; }
      boxEl.innerHTML = '<div style="overflow-x:auto"><table class="utable"><thead><tr><th>Usuario</th><th>UID</th><th>Shell</th><th>Home</th></tr></thead><tbody>' +
        users.map(function (u) {
          return "<tr><td class='mono'>" + esc(u.user) + "</td><td class='mono'>" + esc(u.uid) +
            "</td><td class='mono'>" + esc(u.shell) + "</td><td class='mono'>" + esc(u.home) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    } catch (e) {
      boxEl.innerHTML = '<p class="errline">' + esc(e.message) + "</p>";
    }
  }

  // ---- redimensionar disco --------------------------------------------
  function openDiskResize(dev, capBytes) {
    if (!currentMachine) return;
    diskTarget = { id: currentMachine.id, dev: dev };
    var curGib = capBytes > 0 ? capBytes / (1024 * 1024 * 1024) : 0;
    document.getElementById("diskmodal-title").textContent = "Redimensionar " + dev;
    document.getElementById("diskmodal-info").textContent = curGib > 0
      ? "Tamaño actual: " + curGib.toFixed(1) + " GiB. Solo se puede agrandar."
      : "Indica el nuevo tamaño del disco.";
    var inp = document.getElementById("f-disksize");
    inp.value = curGib > 0 ? String(Math.ceil(curGib) + 1) : "";
    inp.min = curGib > 0 ? String(Math.ceil(curGib)) : "1";
    document.getElementById("diskmodal").hidden = false;
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
  }
  async function saveDiskResize() {
    if (!diskTarget) return;
    var gib = parseFloat(document.getElementById("f-disksize").value);
    if (!gib || gib <= 0) { toast("Pon un tamaño válido", "err"); return; }
    try {
      await api("/api/machines/" + encodeURIComponent(diskTarget.id) +
        "/disks/" + encodeURIComponent(diskTarget.dev) + "/resize",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size_gib: gib }) });
      toast("Disco " + diskTarget.dev + " agrandado a " + gib + " GiB", "ok");
      document.getElementById("diskmodal").hidden = true;
      openFicha(diskTarget.id);
    } catch (e) {
      toast("Error: " + e.message, "err");
    }
  }

  // ---- añadir disco (KVM) ---------------------------------------------
  async function openDiskAdd() {
    if (!currentMachine) return;
    var sel = document.getElementById("f-newdisk-pool");
    sel.innerHTML = '<option value="">Cargando pools…</option>';
    document.getElementById("f-newdisk-size").value = "10";
    document.getElementById("f-newdisk-fmt").value = "qcow2";
    document.getElementById("diskaddmodal-title").textContent = "Añadir disco · " + currentMachine.name;
    document.getElementById("diskaddmodal-note").textContent = currentMachine.state === "run"
      ? "La máquina está encendida: el disco se conecta en caliente y queda guardado en la configuración."
      : "El disco se añade a la configuración y estará disponible al arrancar la máquina.";
    document.getElementById("diskaddmodal").hidden = false;
    try {
      var pools = await api("/api/pools");
      if (!pools.length) {
        sel.innerHTML = '<option value="">No hay pools activos</option>';
      } else {
        sel.innerHTML = pools.map(function (p) {
          return '<option value="' + esc(p.name) + '">' + esc(p.name) +
            (p.available ? " · " + esc(p.available) + " libres" : "") + "</option>";
        }).join("");
      }
    } catch (e) {
      sel.innerHTML = '<option value="">No se pudieron cargar los pools</option>';
    }
  }
  async function saveDiskAdd() {
    if (!currentMachine) return;
    var gib = parseFloat(document.getElementById("f-newdisk-size").value);
    if (!gib || gib <= 0) { toast("Pon un tamaño válido", "err"); return; }
    var pool = document.getElementById("f-newdisk-pool").value || null;
    var fmt = document.getElementById("f-newdisk-fmt").value || "qcow2";
    try {
      await api("/api/machines/" + encodeURIComponent(currentMachine.id) + "/disks",
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ size_gib: gib, pool: pool, format: fmt }) });
      toast("Disco de " + gib + " GiB añadido", "ok");
      document.getElementById("diskaddmodal").hidden = true;
      openFicha(currentMachine.id);
    } catch (e) {
      toast("Error: " + e.message, "err");
    }
  }

  // ---- cambiar recursos (vCPU / memoria) ------------------------------
  function openResources() {
    if (!currentMachine) return;
    var d = currentMachine;
    document.getElementById("resmodal-title").textContent = "Recursos · " + d.name;
    document.getElementById("f-vcpus").value = d.vcpus_n != null ? d.vcpus_n : "";
    document.getElementById("f-memory").value = d.memory_mib != null ? d.memory_mib : "";
    document.getElementById("resmodal-note").textContent = d.state === "run"
      ? "La máquina está encendida: los cambios se aplicarán al apagarla y volver a arrancarla."
      : "Los cambios se aplicarán al arrancar la máquina.";
    document.getElementById("resmodal").hidden = false;
    setTimeout(function () { document.getElementById("f-vcpus").focus(); }, 30);
  }
  async function saveResources() {
    if (!currentMachine) return;
    var vcpus = parseInt(document.getElementById("f-vcpus").value, 10);
    var mem = parseInt(document.getElementById("f-memory").value, 10);
    if (!(vcpus >= 1)) { toast("Pon al menos 1 vCPU", "err"); return; }
    if (!(mem >= 256)) { toast("La memoria mínima es 256 MiB", "err"); return; }
    try {
      await api("/api/machines/" + encodeURIComponent(currentMachine.id) + "/resources",
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vcpus: vcpus, memory_mib: mem }) });
      toast("Recursos actualizados (" + vcpus + " vCPU · " + mem + " MiB)", "ok");
      document.getElementById("resmodal").hidden = true;
      openFicha(currentMachine.id);
    } catch (e) {
      toast("Error: " + e.message, "err");
    }
  }

  // ---- añadir interfaz de red a una máquina (KVM) ---------------------
  function openNicModal() {
    if (!currentMachine) return;
    var nets = currentMachine._kvmnets || [];
    var sel = document.getElementById("f-nic-net");
    if (!nets.length) {
      sel.innerHTML = '<option value="">No hay redes de libvirt</option>';
    } else {
      sel.innerHTML = nets.map(function (n) {
        var label = n.name + " · " + n.mode +
          (n.cidr && n.cidr !== "—" ? " · " + n.cidr : "") + (n.active ? "" : " (inactiva)");
        return '<option value="' + esc(n.name) + '">' + esc(label) + "</option>";
      }).join("");
    }
    document.getElementById("f-nic-model").value = "virtio";
    document.getElementById("nicmodal-title").textContent = "Añadir interfaz · " + currentMachine.name;
    document.getElementById("nicmodal-note").textContent = currentMachine.state === "run"
      ? "La máquina está encendida: la interfaz se conecta en caliente y queda guardada en la configuración."
      : "La interfaz se añade a la configuración y estará disponible al arrancar la máquina.";
    document.getElementById("nicmodal").hidden = false;
  }
  async function saveNic() {
    if (!currentMachine) return;
    var network = document.getElementById("f-nic-net").value;
    if (!network) { toast("Elige una red", "err"); return; }
    var model = document.getElementById("f-nic-model").value || "virtio";
    try {
      await api("/api/machines/" + encodeURIComponent(currentMachine.id) + "/nics",
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ network: network, model: model }) });
      toast("Interfaz conectada a «" + network + "»", "ok");
      document.getElementById("nicmodal").hidden = true;
      openFicha(currentMachine.id);
    } catch (e) {
      toast("Error: " + e.message, "err");
    }
  }

  async function deleteNic(mac) {
    if (!currentMachine) return;
    if (!window.confirm("¿Quitar la interfaz " + mac + "? No se puede deshacer.")) return;
    try {
      await api("/api/machines/" + encodeURIComponent(currentMachine.id) + "/nics/" + encodeURIComponent(mac),
        { method: "DELETE" });
      toast("Interfaz " + mac + " quitada", "ok");
      openFicha(currentMachine.id);
    } catch (e) {
      toast("Error: " + e.message, "err");
    }
  }

  // ---- redes -----------------------------------------------------------
  function netActs(n) {
    var key = esc(n.backend + "|" + n.name);
    var acts = "";
    if (n.backend === "kvm") {
      acts += '<button class="iact" title="Editar" data-net-edit="' + key + '">' + svg(ICON.edit) + "</button>";
      var op = n.active ? "deactivate" : "activate";
      acts += '<button class="iact" title="' + (n.active ? "Desactivar" : "Activar") + '" data-net-act="' +
        esc(n.backend + "|" + n.name + "|" + op) + '">' + svg(ICON.power) + "</button>";
    }
    acts += '<button class="iact danger" title="Borrar" data-net-del="' + key + '">' + svg(ICON.trash) + "</button>";
    return '<span class="nc-acts">' + acts + "</span>";
  }

  async function loadNetworks() {
    var wrap = document.getElementById("netcards");
    wrap.innerHTML = '<p class="muted">Cargando redes…</p>';
    try {
      netsData = await api("/api/networks");
      if (!netsData.length) { wrap.innerHTML = '<p class="muted">No hay redes.</p>'; return; }
      wrap.innerHTML = netsData.map(function (n) {
        var t = ty(n.backend);
        var chips = (n.machines && n.machines.length)
          ? n.machines.map(function (m) {
            return '<button class="mchip" data-goto="' + esc(m.type + ":" + m.name) + '">' + esc(m.name) +
              (m.ip ? ' <span class="mono">· ' + esc(m.ip) + "</span>" : "") + "</button>";
          }).join("")
          : '<span class="nc-empty">sin máquinas conectadas</span>';
        return '<div class="netcard card" data-netkey="' + esc(n.backend + "|" + n.name) + '">' +
          '<div class="nc-h"><span class="badge ' + t[0] + '">' + t[1] + "</span>" +
          '<span class="nc-name">' + esc(n.name) + "</span>" +
          '<span class="pill ' + (n.active ? "p-run" : "p-stop") + '"><span class="dot"></span>' + (n.active ? "activa" : "inactiva") + "</span>" +
          netActs(n) + "</div>" +
          '<div class="nc-b"><dl class="nc-grid">' +
          '<div><dt>Modo</dt><dd>' + esc(n.mode) + "</dd></div>" +
          '<div><dt>CIDR</dt><dd class="mono">' + esc(n.cidr) + "</dd></div>" +
          '<div><dt>Puerta de enlace</dt><dd class="mono">' + esc(n.gateway) + "</dd></div>" +
          '<div><dt>DHCP</dt><dd class="mono">' + esc(n.dhcp) + "</dd></div>" +
          "</dl>" +
          '<div class="nc-m"><span class="nc-mlbl">Máquinas conectadas · ' + (n.machines ? n.machines.length : 0) +
          '</span><div class="chips">' + chips + "</div></div></div></div>";
      }).join("");
      if (pendingNetKey) {
        var key = pendingNetKey; pendingNetKey = null;
        wrap.querySelectorAll(".netcard").forEach(function (c) {
          if (c.getAttribute("data-netkey") === key) {
            try { c.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
            c.classList.add("flash");
            setTimeout(function () { c.classList.remove("flash"); }, 1700);
          }
        });
      }
    } catch (e) {
      wrap.innerHTML = '<p class="errline">No se pudieron cargar las redes: ' + esc(e.message) + "</p>";
    }
  }
  function gotoNetwork(key) { pendingNetKey = key; show("redes"); }

  document.getElementById("netcards").addEventListener("click", function (e) {
    var del = e.target.closest("[data-net-del]");
    var edit = e.target.closest("[data-net-edit]");
    var act = e.target.closest("[data-net-act]");
    var chip = e.target.closest("[data-goto]");
    if (del) netDelete(del.getAttribute("data-net-del"));
    else if (edit) openNetEdit(edit.getAttribute("data-net-edit"));
    else if (act) netAction(act.getAttribute("data-net-act"));
    else if (chip) openFicha(chip.getAttribute("data-goto"));
  });

  // ---- modal de red (crear / editar) ----------------------------------
  function nf(id) { return document.getElementById(id); }
  function openNetModal() { nf("netmodal").hidden = false; }
  function closeNetModal() { nf("netmodal").hidden = true; }
  function toggleNetFields() {
    var backend = nf("f-backend").value;
    document.querySelector('[data-for="kvm"]').hidden = backend !== "kvm";
    document.querySelector('[data-for="docker"]').hidden = backend !== "docker";
    var mode = nf("f-mode-kvm").value;
    document.querySelector('[data-kvm="ip"]').hidden = mode === "bridge";
    document.querySelector('[data-kvm="bridge"]').hidden = mode !== "bridge";
  }

  function openNetCreate() {
    netMode = "create"; netEditTarget = null;
    nf("netmodal-title").textContent = "Añadir red";
    nf("f-backend").disabled = false; nf("f-backend").value = "kvm";
    nf("f-name").disabled = false; nf("f-name").value = "";
    nf("f-mode-kvm").value = "nat";
    ["f-gw", "f-prefix", "f-dstart", "f-dend", "f-bridge", "f-subnet", "f-dgw"].forEach(function (i) { nf(i).value = ""; });
    nf("f-autostart").checked = true;
    nf("f-driver").value = "bridge";
    nf("netmodal-note").textContent = "";
    toggleNetFields();
    openNetModal();
  }

  function openNetEdit(key) {
    var parts = key.split("|"), backend = parts[0], name = parts.slice(1).join("|");
    if (backend !== "kvm") { toast("Las redes de Docker no se editan: bórrala y créala de nuevo."); return; }
    var n = netsData.filter(function (x) { return x.backend === backend && x.name === name; })[0];
    if (!n) return;
    netMode = "edit"; netEditTarget = { backend: backend, name: name };
    nf("netmodal-title").textContent = "Editar red · " + name;
    nf("f-backend").value = "kvm"; nf("f-backend").disabled = true;
    nf("f-name").value = name; nf("f-name").disabled = true;
    var modeMap = { "NAT": "nat", "Aislada": "isolated", "Puente": "bridge", "Ruta": "route", "Abierta": "open" };
    nf("f-mode-kvm").value = modeMap[n.mode] || "nat";
    nf("f-gw").value = (n.gateway && n.gateway !== "—") ? n.gateway : "";
    nf("f-prefix").value = (n.cidr && n.cidr.indexOf("/") >= 0) ? n.cidr.split("/")[1] : "";
    var dhcp = n.dhcp || "";
    if (dhcp.indexOf("–") >= 0) { var dp = dhcp.split("–"); nf("f-dstart").value = dp[0].trim(); nf("f-dend").value = dp[1].trim(); }
    else { nf("f-dstart").value = ""; nf("f-dend").value = ""; }
    nf("f-bridge").value = n.bridge || "";
    nf("f-autostart").checked = true;
    nf("netmodal-note").textContent = "Editar recrea la red (se reinicia un instante); las máquinas conectadas se desconectan brevemente.";
    toggleNetFields();
    openNetModal();
  }

  async function saveNet() {
    var backend = nf("f-backend").value;
    var name = nf("f-name").value.trim();
    if (!name) { toast("Pon un nombre a la red", "err"); return; }
    var payload;
    if (backend === "kvm") {
      payload = {
        backend: "kvm", name: name, mode: nf("f-mode-kvm").value,
        gateway: nf("f-gw").value.trim(), prefix: nf("f-prefix").value.trim(),
        dhcp_start: nf("f-dstart").value.trim(), dhcp_end: nf("f-dend").value.trim(),
        bridge: nf("f-bridge").value.trim(), autostart: nf("f-autostart").checked,
      };
    } else {
      payload = {
        backend: "docker", name: name, mode: nf("f-driver").value,
        cidr: nf("f-subnet").value.trim(), gateway: nf("f-dgw").value.trim(),
      };
    }
    try {
      if (netMode === "edit" && netEditTarget) {
        await api("/api/networks/" + encodeURIComponent(netEditTarget.backend) + "/" + encodeURIComponent(netEditTarget.name),
          { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        toast("Red actualizada", "ok");
      } else {
        await api("/api/networks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        toast("Red creada", "ok");
      }
      closeNetModal();
      loadNetworks();
    } catch (e) {
      toast("Error: " + e.message, "err");
    }
  }

  async function netDelete(key) {
    var parts = key.split("|"), backend = parts[0], name = parts.slice(1).join("|");
    if (!window.confirm("¿Borrar la red «" + name + "»? No se puede deshacer.")) return;
    try {
      await api("/api/networks/" + encodeURIComponent(backend) + "/" + encodeURIComponent(name), { method: "DELETE" });
      toast("Red borrada", "ok");
      loadNetworks();
    } catch (e) { toast("Error: " + e.message, "err"); }
  }

  async function netAction(key) {
    var parts = key.split("|"), backend = parts[0], name = parts[1], op = parts[2];
    try {
      await api("/api/networks/" + encodeURIComponent(backend) + "/" + encodeURIComponent(name) + "/action",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: op }) });
      toast(op === "activate" ? "Red activada" : "Red desactivada", "ok");
      loadNetworks();
    } catch (e) { toast("Error: " + e.message, "err"); }
  }

  // ---- consola (varias sesiones a la vez) -----------------------------
  var sessions = [];        // { sid, machineId, label, term, fit, ws, el, tab }
  var activeSid = null;
  var sidSeq = 0;
  var MIN_FONT = 9, MAX_FONT = 28;
  var fontSize = 13;

  function termKeyHandler(ev) {
    // Solo interceptamos el zoom (Ctrl +/−/0); el resto pasa a la terminal.
    if (ev.type !== "keydown" || ev.altKey || ev.metaKey || !ev.ctrlKey) return true;
    if (ev.key === "+" || ev.key === "=" || ev.code === "NumpadAdd") { changeFont(1); return false; }
    if (ev.key === "-" || ev.key === "_" || ev.code === "NumpadSubtract") { changeFont(-1); return false; }
    if (ev.key === "0") { setFont(13); return false; }
    return true;
  }
  function setFont(px) {
    fontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, px));
    sessions.forEach(function (s) { try { s.term.options.fontSize = fontSize; } catch (e) {} });
    var a = activeSession(); if (a) fitSession(a);
  }
  function changeFont(delta) { setFont(fontSize + delta); }

  function activeSession() {
    for (var i = 0; i < sessions.length; i++) if (sessions[i].sid === activeSid) return sessions[i];
    return null;
  }

  // En consola serie (KVM) el `clear` lo ejecuta el shell del guest con su
  // propio TERM; si está vacío/dumb no emite nada y la pantalla no se limpia.
  // Detectamos un `clear`/`cls` escrito (o Ctrl+L) y limpiamos el buffer de
  // xterm desde el cliente, pero solo en el buffer normal: así nunca borra la
  // pantalla de una app a pantalla completa (vim, less, htop…).
  function scheduleLocalClear(s) {
    setTimeout(function () {
      try { if (s.term.buffer.active.type === "normal") s.term.clear(); } catch (e) {}
    }, 90);
  }
  function trackClear(s, data) {
    for (var i = 0; i < data.length; i++) {
      var ch = data[i];
      if (ch === "\r" || ch === "\n") {
        var cmd = s.lineBuf.trim();
        s.lineBuf = "";
        if (cmd === "clear" || cmd === "cls") scheduleLocalClear(s);
      } else if (ch === "\x0c") {           // Ctrl+L
        scheduleLocalClear(s);
      } else if (ch === "\x7f" || ch === "\b") {
        s.lineBuf = s.lineBuf.slice(0, -1);
      } else if (ch === "\x15" || ch === "\x03" || ch === "\x1b") { // Ctrl+U / Ctrl+C / ESC
        s.lineBuf = "";
      } else if (ch >= " ") {
        s.lineBuf += ch;
      }
    }
  }
  function fitSession(s, syncGuest) {
    if (!s) return;
    if (s.fit) { try { s.fit.fit(); } catch (e) {} }
    if (s.ws && s.ws.readyState === 1 && s.term) {
      try { s.ws.send(JSON.stringify({ type: "resize", cols: s.term.cols, rows: s.term.rows })); } catch (e) {}
      if (syncGuest !== false) scheduleGuestSize(s);
    }
  }
  // La consola de KVM es SERIE (virsh console): el tamaño del PTY del host no
  // llega al invitado por la línea serie, así que su tty se queda en 80x24 y las
  // apps a pantalla completa (nano, vim, htop) se cortan al agrandar la ventana.
  // Se lo comunicamos con `stty`, pero solo si estamos en el shell (buffer normal
  // y sin nada escrito a medias), para no pisar lo que el usuario teclea ni
  // interferir dentro de una app a pantalla completa.
  var guestSizeTimer = null;
  var _td = (typeof TextDecoder !== "undefined") ? new TextDecoder() : null;
  var ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[\]P].*?(?:\x07|\x1b\\)/g;
  // Prompt de shell típico (usuario@host … $ / #). Deliberadamente NO casa con
  // "login:" ni "Password:", para no tocar nada durante el inicio de sesión.
  var PROMPT_RE = /[^\s@]+@[^\s]+.*[#$]\s?$/;
  // Envía el tamaño al guest con `stty` SOLO si ya hemos visto un shell real
  // (s.shellReady), estamos en buffer normal, sin nada escrito a medias y el
  // tamaño cambió. Marca `hide` para ocultar el eco del comando.
  function syncGuestSize(s) {
    if (!s || !s.ws || s.ws.readyState !== 1 || !s.term) return false;
    if (!/^kvm:/.test(s.machineId)) return false;
    if (!s.shellReady) return false;                 // nunca antes de un shell real (p. ej. login)
    var size = s.term.rows + "x" + s.term.cols;
    if (size === s.syncedSize) return true;          // ya está, no reenviar
    try { if (s.term.buffer.active.type !== "normal") return false; } catch (e) {}
    if (s.lineBuf && s.lineBuf.length) return false;
    var cmd = "stty rows " + s.term.rows + " cols " + s.term.cols;
    try { s.ws.send(new TextEncoder().encode(cmd + "\n")); } catch (e) { return false; }
    s.syncedSize = size;
    s.hide = { cmd: cmd, buf: "", start: Date.now() };  // oculta el eco del comando
    return true;
  }
  function scheduleGuestSize(s) {
    if (guestSizeTimer) clearTimeout(guestSizeTimer);
    guestSizeTimer = setTimeout(function () { syncGuestSize(s); }, 350);
  }
  // Vigila la salida: cuando aparece un prompt de shell real, lo marca y, si el
  // tamaño cambió, lo sincroniza (oculto). Mientras no haya shell, no hace nada,
  // así el login nunca se toca.
  function watchForShell(s, chunk) {
    try {
      if (!/^kvm:/.test(s.machineId)) return;
      if (s.term.buffer.active.type !== "normal") return;
      s.outTail = ((s.outTail || "") + chunk).replace(ANSI_RE, "").slice(-240);
      var lastLine = s.outTail.split(/[\r\n]/).pop();
      if (/login:\s*$/i.test(lastLine) || /password/i.test(lastLine)) return;
      if (!PROMPT_RE.test(lastLine)) return;
      s.shellReady = true;
      syncGuestSize(s);            // sincroniza si el tamaño cambió (dedupe dentro)
    } catch (e) {}
  }
  // Mientras `s.hide` está activo, retiene la salida hasta tener la línea del eco
  // del `stty …` y borra solo ese texto (conservando el salto de línea), para que
  // el ajuste no se vea. Flush de seguridad por tamaño/tiempo, sin bloquear nunca.
  function feedTerm(s, str) {
    var h = s.hide;
    if (!h) { s.term.write(str); return; }
    h.buf += str;
    var nl = h.buf.indexOf("\n");
    if (nl < 0) {
      if (h.buf.length > 2048 || (Date.now() - h.start) > 600) { s.term.write(h.buf); s.hide = null; }
      return;                                         // espera a tener la línea del eco
    }
    var out = h.buf;
    var idx = out.indexOf(h.cmd);
    if (idx >= 0) out = out.slice(0, idx) + out.slice(idx + h.cmd.length);  // quita solo el texto del comando
    s.term.write(out);
    s.hide = null;
  }
  // Fuerza a xterm a volver a medir el ancho de carácter (necesario cuando la
  // webfont IBM Plex Mono termina de cargar DESPUÉS de abrir la terminal: si no,
  // la rejilla se midió con la fuente de reserva y los glifos se solapan, p. ej.
  // en nano o al escribir comandos largos). Reasignar el tamaño dispara la
  // remedición; luego re-ajustamos filas/columnas.
  function remeasureAndFit(s, syncGuest) {
    if (!s || !s.term) return;
    try {
      var fs = s.term.options.fontSize;
      s.term.options.fontSize = fs + 1;
      s.term.options.fontSize = fs;
    } catch (e) {}
    fitSession(s, syncGuest);
  }
  function renderStrip() {
    var strip = document.getElementById("termstrip");
    strip.hidden = sessions.length === 0;
    strip.innerHTML = sessions.map(function (s) {
      return '<div class="tchip' + (s.sid === activeSid ? " on" : "") + '" data-sid="' + s.sid + '">' +
        '<span class="st ' + s.stateClass + '"></span>' +
        '<span class="tl">' + esc(s.label) + "</span>" +
        '<button class="tx" data-close="' + s.sid + '" title="Cerrar" aria-label="Cerrar">&times;</button></div>';
    }).join("");
    document.getElementById("termempty").hidden = sessions.length > 0;
  }
  function activate(sid) {
    activeSid = sid;
    sessions.forEach(function (s) { s.el.hidden = s.sid !== sid; });
    renderStrip();
    var a = activeSession();
    if (a) { setTimeout(function () { remeasureAndFit(a); try { a.term.focus(); } catch (e) {} }, 30); }
  }
  function closeSession(sid) {
    var i = -1;
    for (var k = 0; k < sessions.length; k++) if (sessions[k].sid === sid) { i = k; break; }
    if (i < 0) return;
    var s = sessions[i];
    if (s.ws) { try { s.ws.close(); } catch (e) {} }
    try { s.term.dispose(); } catch (e) {}
    try { s.el.remove(); } catch (e) {}
    sessions.splice(i, 1);
    if (activeSid === sid) {
      var next = sessions[i] || sessions[i - 1] || null;
      if (next) activate(next.sid); else { activeSid = null; renderStrip(); }
    } else {
      renderStrip();
    }
  }

  function newSession(id) {
    if (!id) return;
    var m = machines.filter(function (x) { return x.id === id; })[0];
    var label = (m ? m.name : id);
    var sid = ++sidSeq;
    var el = document.createElement("div");
    el.className = "term-pane";
    document.getElementById("termbox").appendChild(el);

    var term = new Terminal({ fontFamily: '"IBM Plex Mono", monospace', fontSize: fontSize, cursorBlink: true,
      scrollback: 5000, theme: { background: "#0c0e13", foreground: "#c3cbd6" } });
    var fit = null;
    try { fit = new FitAddon.FitAddon(); term.loadAddon(fit); } catch (e) { fit = null; }
    term.open(el);
    term.attachCustomKeyEventHandler(termKeyHandler);

    var s = { sid: sid, machineId: id, label: label, term: term, fit: fit, ws: null, el: el, stateClass: "c-wait", lineBuf: "", outTail: "", shellReady: false, syncedSize: "", hide: null };
    sessions.push(s);

    term.onData(function (data) {
      trackClear(s, data);
      if (s.ws && s.ws.readyState === 1) s.ws.send(new TextEncoder().encode(data));
    });
    term.onResize(function () { fitSession(s); });

    activate(sid);
    connectSession(s);
    return s;
  }
  function connectSession(s) {
    s.stateClass = "c-wait"; renderStrip();
    var proto = location.protocol === "https:" ? "wss" : "ws";
    var ws = new WebSocket(proto + "://" + location.host + "/ws/console/" + encodeURIComponent(s.machineId));
    ws.binaryType = "arraybuffer";
    s.ws = ws;
    ws.onopen = function () {
      s.stateClass = "c-on"; renderStrip();
      s.outTail = ""; s.hide = null; s.syncedSize = ""; s.shellReady = false;
      remeasureAndFit(s, false);
      if (window.__fontsReady === false) {
        // Si la fuente aún no estaba lista al abrir, re-mide al terminar de cargar.
        try { document.fonts.ready.then(function () { remeasureAndFit(s, false); }); } catch (e) {}
      }
      if (s.sid === activeSid) { try { s.term.focus(); } catch (e) {} }
    };
    ws.onmessage = function (e) {
      var str, bin = null;
      if (typeof e.data === "string") str = e.data;
      else { bin = new Uint8Array(e.data); str = _td ? _td.decode(bin) : ""; }
      if (s.hide) feedTerm(s, str);
      else if (bin) s.term.write(bin);
      else s.term.write(str);
      if (str) watchForShell(s, str);
    };
    ws.onclose = function () {
      s.stateClass = "c-off"; renderStrip();
      try { s.term.write("\r\n\x1b[90m[conexión cerrada]\x1b[0m\r\n"); } catch (e) {}
    };
    ws.onerror = function () { s.stateClass = "c-off"; renderStrip(); };
  }

  function setConsoleMax(on) {
    var box = document.getElementById("termbox");
    if (!box) return;
    box.classList.toggle("maxed", on);
    document.getElementById("consolereduce").hidden = !on;
    var a = activeSession();
    setTimeout(function () { if (a) { remeasureAndFit(a); try { a.term.focus(); } catch (e) {} } }, 60);
  }
  function fillConsoleSelect() {
    var sel = document.getElementById("consolesel");
    var cur = sel.value;
    var running = machines.filter(function (m) { return m.state === "run"; });
    if (!running.length) {
      sel.innerHTML = '<option value="">No hay máquinas encendidas</option>';
      document.getElementById("consolestart").disabled = true;
      return;
    }
    document.getElementById("consolestart").disabled = false;
    sel.innerHTML = running.map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(TY[m.type] ? TY[m.type][1] : m.type) + " · " + esc(m.name) + "</option>";
    }).join("");
    if (cur && running.some(function (m) { return m.id === cur; })) sel.value = cur;
  }
  function openConsole(id) {
    show("consola");
    fillConsoleSelect();
    // Si ya hay una consola abierta de esa máquina, la activamos; si no, una nueva.
    var existing = sessions.filter(function (s) { return s.machineId === id; })[0];
    if (existing) activate(existing.sid);
    else newSession(id);
  }

  document.getElementById("consolestart").addEventListener("click", function () {
    newSession(document.getElementById("consolesel").value);
  });
  document.getElementById("termstrip").addEventListener("click", function (e) {
    var x = e.target.closest("[data-close]");
    if (x) { e.stopPropagation(); closeSession(parseInt(x.getAttribute("data-close"), 10)); return; }
    var chip = e.target.closest("[data-sid]");
    if (chip) activate(parseInt(chip.getAttribute("data-sid"), 10));
  });
  document.getElementById("consolemax").addEventListener("click", function () {
    setConsoleMax(!document.getElementById("termbox").classList.contains("maxed"));
  });
  document.getElementById("consolereduce").addEventListener("click", function () { setConsoleMax(false); });
  window.addEventListener("resize", function () { fitSession(activeSession()); });

  // La webfont puede cargar después de abrir una consola: al estar lista,
  // forzamos remedir todas las sesiones para que no se solapen los glifos.
  window.__fontsReady = false;
  try {
    document.fonts.ready.then(function () {
      window.__fontsReady = true;
      sessions.forEach(remeasureAndFit);
    });
  } catch (e) { window.__fontsReady = true; }

  // Re-ajusta la rejilla cuando cambia el tamaño del contenedor (arrastre, etc.).
  if (window.ResizeObserver) {
    var roPending = false;
    var ro = new ResizeObserver(function () {
      if (roPending) return;
      roPending = true;
      requestAnimationFrame(function () { roPending = false; fitSession(activeSession(), false); });
    });
    try { ro.observe(document.getElementById("termbox")); } catch (e) {}
  }

  // Tirador para arrastrar y cambiar el alto de la consola.
  (function () {
    var box = document.getElementById("termbox");
    var handle = document.getElementById("termresizer");
    if (!box || !handle) return;
    try {
      var saved = parseInt(localStorage.getItem("nexora-term-h"), 10);
      if (saved >= 240) box.style.height = saved + "px";
    } catch (e) {}
    var dragging = false, startY = 0, startH = 0;
    handle.addEventListener("pointerdown", function (e) {
      if (box.classList.contains("maxed")) return;
      dragging = true; startY = e.clientY; startH = box.getBoundingClientRect().height;
      try { handle.setPointerCapture(e.pointerId); } catch (e2) {}
      document.body.style.userSelect = "none";
    });
    handle.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var h = Math.max(240, Math.min(window.innerHeight - 120, startH + (e.clientY - startY)));
      box.style.height = h + "px";
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      try { localStorage.setItem("nexora-term-h", Math.round(box.getBoundingClientRect().height)); } catch (e) {}
      fitSession(activeSession());
    }
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  })();

  // ---- arranque --------------------------------------------------------
  async function init() {
    wireChips("tipofilter");
    document.getElementById("maqsearch").addEventListener("input", applyFilters);
    document.getElementById("estadosel").addEventListener("change", applyFilters);
    document.getElementById("refresh").addEventListener("click", function () { loadMachines(); });

    nf("netadd").addEventListener("click", openNetCreate);
    nf("netmodal-x").addEventListener("click", closeNetModal);
    nf("netmodal-cancel").addEventListener("click", closeNetModal);
    nf("netmodal-save").addEventListener("click", saveNet);
    nf("f-backend").addEventListener("change", toggleNetFields);
    nf("f-mode-kvm").addEventListener("change", toggleNetFields);
    nf("netmodal").addEventListener("click", function (e) { if (e.target.id === "netmodal") closeNetModal(); });

    nf("diskmodal-x").addEventListener("click", function () { nf("diskmodal").hidden = true; });
    nf("diskmodal-cancel").addEventListener("click", function () { nf("diskmodal").hidden = true; });
    nf("diskmodal-save").addEventListener("click", saveDiskResize);
    nf("diskmodal").addEventListener("click", function (e) { if (e.target.id === "diskmodal") nf("diskmodal").hidden = true; });

    nf("diskaddmodal-x").addEventListener("click", function () { nf("diskaddmodal").hidden = true; });
    nf("diskaddmodal-cancel").addEventListener("click", function () { nf("diskaddmodal").hidden = true; });
    nf("diskaddmodal-save").addEventListener("click", saveDiskAdd);
    nf("diskaddmodal").addEventListener("click", function (e) { if (e.target.id === "diskaddmodal") nf("diskaddmodal").hidden = true; });

    nf("resmodal-x").addEventListener("click", function () { nf("resmodal").hidden = true; });
    nf("resmodal-cancel").addEventListener("click", function () { nf("resmodal").hidden = true; });
    nf("resmodal-save").addEventListener("click", saveResources);
    nf("resmodal").addEventListener("click", function (e) { if (e.target.id === "resmodal") nf("resmodal").hidden = true; });

    nf("nicmodal-x").addEventListener("click", function () { nf("nicmodal").hidden = true; });
    nf("nicmodal-cancel").addEventListener("click", function () { nf("nicmodal").hidden = true; });
    nf("nicmodal-save").addEventListener("click", saveNic);
    nf("nicmodal").addEventListener("click", function (e) { if (e.target.id === "nicmodal") nf("nicmodal").hidden = true; });

    try { modules = await api("/api/modules"); } catch (e) { modules = []; }
    renderModuleChips();
    wireChips("modulofilter");
    await loadMachines();

    var start = (location.hash || "").replace("#", "");
    show(VIEWS.indexOf(start) >= 0 ? start : "maquinas");

    // refresco periódico de la lista + métricas
    setInterval(loadMachines, 15000);
  }

  init();
})();
