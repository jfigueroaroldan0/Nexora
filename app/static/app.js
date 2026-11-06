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
        ? '<button class="iact" title="Apagar" data-act="stop">' + svg(ICON.stop) + "</button>"
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
    document.getElementById("maqsub").textContent = total + " máquinas · " + run + " encendidas";

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
    html += '<button class="tbtn sm" data-console="1">' + svg(ICON.term) + "Consola</button>";
    return html;
  }

  function renderFicha(d) {
    var t = ty(d.type), s = st(d.state);
    var html = "";
    html += '<div class="detailtop"><h2 id="fichaName">' + esc(d.name) + "</h2>" +
      '<span class="badge ' + t[0] + '">' + t[1] + "</span>" +
      (d.module ? '<span class="tag" style="background:var(--surface-2);color:var(--ink-2)">' + esc(d.module) + "</span>" : "") +
      '<span class="pill ' + s[0] + '"><span class="dot"></span>' + s[1] + "</span>" +
      (d.ref ? '<span class="mono res">' + esc(d.ref) + "</span>" : "") + "</div>";
    html += '<div class="lifecycle" data-id="' + esc(d.id) + '">' + lifecycleButtons(d) + "</div>";

    html += '<div class="detail"><div class="col">';
    // Descripción y notas
    html += card("Descripción y notas",
      (d.description ? "<p>" + esc(d.description) + "</p>" : '<p class="muted">Sin descripción.</p>') +
      (d.notes ? '<div class="md">' + esc(d.notes) + "</div>" : "") +
      ((d.tags && d.tags.length) ? '<div class="taglist" style="margin-top:10px">' +
        d.tags.map(function (x) { return '<span class="tag" style="background:var(--surface-2);color:var(--ink-2)">' + esc(x) + "</span>"; }).join("") +
        "</div>" : ""));
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
    if (d.disks && d.disks.length) {
      html += card("Discos", d.disks.map(function (dk) {
        return '<div class="listrow"><span><span class="nm">' + esc(dk.dev) + "</span> " +
          '<span class="meta">· ' + esc(dk.device) + (dk.format ? " · " + esc(dk.format) : "") + "</span></span>" +
          '<span class="right mono res" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">' + esc(dk.source) + "</span></div>";
      }).join(""));
    }
    // Interfaces
    if (d.nics && d.nics.length) {
      html += card("Interfaces de red", d.nics.map(function (n) {
        return '<div class="listrow"><span><span class="nm">' + esc(n.network || "—") + "</span> " +
          '<span class="meta mono">' + esc(n.mac || "") + "</span></span>" +
          '<span class="right mono res">' + esc(n.ip || "") + "</span></div>";
      }).join(""));
    }
    // Redes que usa la máquina
    if (d._networks && d._networks.length) {
      html += card("Redes que usa", d._networks.map(function (n) {
        var mine = (n.machines || []).filter(function (m) { return m.type + ":" + m.name === d.id; })[0];
        var ip = mine && mine.ip ? mine.ip : "";
        var t = ty(n.backend);
        var meta = esc(n.mode) + (n.cidr && n.cidr !== "—" ? " · " + esc(n.cidr) : "");
        return '<div class="listrow"><span class="badge ' + t[0] + '">' + t[1] + "</span>" +
          '<span><span class="nm">' + esc(n.name) + '</span> <span class="meta">· ' + meta + "</span></span>" +
          '<span class="right mono res">' + esc(ip) + "</span></div>";
      }).join(""));
    }
    html += "</div></div>";
    document.getElementById("fichaBody").innerHTML = html;
  }

  function card(title, inner) {
    return '<div class="card"><div class="panel-h"><h3>' + title + '</h3></div><div class="panel-b">' + inner + "</div></div>";
  }

  document.getElementById("fichaBody").addEventListener("click", function (e) {
    var id = (e.target.closest(".lifecycle") || {}).getAttribute ? e.target.closest(".lifecycle").getAttribute("data-id") : null;
    var act = e.target.closest("[data-fichaact]");
    if (act && id) { doAction(id, act.getAttribute("data-fichaact")); setTimeout(function () { openFicha(id); }, 800); return; }
    if (e.target.closest("[data-console]") && id) { openConsole(id); return; }
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
        return '<div class="netcard card">' +
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
    } catch (e) {
      wrap.innerHTML = '<p class="errline">No se pudieron cargar las redes: ' + esc(e.message) + "</p>";
    }
  }

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

  // ---- consola ---------------------------------------------------------
  var term = null, fit = null, wsConn = null;
  function ensureTerm() {
    if (term) return;
    term = new Terminal({ fontFamily: '"IBM Plex Mono", monospace', fontSize: 13, cursorBlink: true,
      theme: { background: "#0c0e13", foreground: "#c3cbd6" } });
    try { fit = new FitAddon.FitAddon(); term.loadAddon(fit); } catch (e) { fit = null; }
    term.open(document.getElementById("term"));
    doFit();
    window.addEventListener("resize", doFit);
    term.onData(function (data) { if (wsConn && wsConn.readyState === 1) wsConn.send(new TextEncoder().encode(data)); });
    term.onResize(function () { doFit(); });
  }
  function doFit() {
    if (fit) { try { fit.fit(); } catch (e) {} }
    if (wsConn && wsConn.readyState === 1 && term) {
      wsConn.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  }
  function setConsoleMax(on) {
    var box = document.getElementById("termbox");
    if (!box) return;
    box.classList.toggle("maxed", on);
    document.getElementById("consolereduce").hidden = !on;
    ensureTerm();
    setTimeout(function () { doFit(); if (term) term.focus(); }, 60);
  }
  function fillConsoleSelect() {
    var sel = document.getElementById("consolesel");
    var cur = sel.value;
    sel.innerHTML = machines.map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(TY[m.type] ? TY[m.type][1] : m.type) + " · " + esc(m.name) + "</option>";
    }).join("");
    if (cur) sel.value = cur;
  }
  function closeConsole() {
    if (wsConn) { try { wsConn.close(); } catch (e) {} wsConn = null; }
    document.getElementById("consolestop").hidden = true;
    document.getElementById("consolestatus").textContent = "";
  }
  function openConsole(id) {
    show("consola");
    fillConsoleSelect();
    if (id) document.getElementById("consolesel").value = id;
    connectConsole();
  }
  function connectConsole() {
    ensureTerm();
    closeConsole();
    var id = document.getElementById("consolesel").value;
    if (!id) return;
    term.reset();
    var proto = location.protocol === "https:" ? "wss" : "ws";
    var ws = new WebSocket(proto + "://" + location.host + "/ws/console/" + encodeURIComponent(id));
    ws.binaryType = "arraybuffer";
    wsConn = ws;
    var status = document.getElementById("consolestatus");
    status.textContent = "conectando…";
    ws.onopen = function () {
      status.textContent = "conectado";
      document.getElementById("consolestop").hidden = false;
      doFit();
      term.focus();
    };
    ws.onmessage = function (e) {
      if (typeof e.data === "string") term.write(e.data);
      else term.write(new Uint8Array(e.data));
    };
    ws.onclose = function () { status.textContent = "desconectado"; document.getElementById("consolestop").hidden = true; };
    ws.onerror = function () { status.textContent = "error de conexión"; };
  }
  document.getElementById("consolestart").addEventListener("click", connectConsole);
  document.getElementById("consolestop").addEventListener("click", closeConsole);
  document.getElementById("consolemax").addEventListener("click", function () {
    setConsoleMax(!document.getElementById("termbox").classList.contains("maxed"));
  });
  document.getElementById("consolereduce").addEventListener("click", function () { setConsoleMax(false); });

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
