/* ═══════════════════════════════════════════════════════════════════════
   airport-picker.js — shared airport / metro search field
   Monitors in the Terminal · used by index, browse-timetables, view-the-monitors

   Usage
     AirportPicker.load(SUPABASE_URL)                 -> Promise (loads once, shared)
     const p = AirportPicker.attach(inputEl, { allowMetros: true, role: 'origin' })
     p.setSeason(seasonCode, seasonLabel)             -> limits list to airports served that year
     p.resolve()                                      -> selected entry or null (flags the field)
     p.filterParam('origin')                          -> "origin_code=eq.CHS" / "origin_code=in.(DCA,IAD,BWI)"
     p.codes(), p.displayName(), p.clear(), p.setFromText(str)
     AirportPicker.swap(pickerA, pickerB)

   Data
     Preferred: airport_directory (materialized view; one row per airport that
     has flights, with per-season counts) — enables year filtering + traffic ranking.
     Fallback:  airports table (all rows, paged) — no year filtering.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const PAGE = 1000;       // requested page size; paging stops on an empty page, so a lower server cap is still safe
    const MAX_SHOWN = 14;

    // ── Shared directory ───────────────────────────────────────────────
    const dir = {
        loaded: false,
        seasonAware: false,  // true when per-season counts are available
        airports: [],
        metros: [],
        airportByCode: {},
        metroByCode: {}
    };
    let loadPromise = null;
    const pickers = [];

    async function fetchAllRows(url) {
        const out = [];
        let offset = 0;
        for (let guard = 0; guard < 100; guard++) {
            const sep = url.includes('?') ? '&' : '?';
            const res = await fetch(`${url}${sep}limit=${PAGE}&offset=${offset}`);
            if (!res.ok) throw new Error(`API error ${res.status}`);
            const batch = await res.json();
            if (!Array.isArray(batch) || batch.length === 0) break;
            out.push(...batch);
            offset += batch.length;
        }
        return out;
    }

    function norm(s) {
        return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    }
    function wordsOf(s) { return norm(s).split(/[^a-z0-9]+/).filter(Boolean); }
    function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function escHtml(s) {
        return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    // "Charleston, SC (CHS)" -> "Charleston, SC"   (list rows show the code in its own column)
    function stripCode(name, code) {
        if (!name) return code;
        const s = name.replace(new RegExp('\\s*\\(' + escRe(code) + '\\)\\s*$', 'i'), '');
        return s || name;
    }

    function makeEntry(type, code, name) {
        // Metros: "Washington, DC (All Airports)" -> "Washington, DC" in list rows (the row says "All N airports")
        const label = type === 'metro'
            ? ((name || code).replace(/\s*\([^)]*\)\s*$/, '') || name || code)
            : stripCode(name, code);
        return {
            type, code, name: name || code, label,
            codeLc: norm(code), nameLc: norm(label),
            words: wordsOf(label).concat(norm(code)),
            counts: {}, total: 0, members: null, metroCode: null
        };
    }

    function build(rows, metroRows, seasonAware) {
        dir.airports = []; dir.metros = []; dir.airportByCode = {}; dir.metroByCode = {};
        dir.seasonAware = seasonAware;

        rows.forEach(r => {
            if (!r.airport_code || dir.airportByCode[r.airport_code]) return;
            const e = makeEntry('airport', r.airport_code, r.display_name);
            e.metroCode = r.metro_code || null;
            if (seasonAware && r.season_counts) {
                Object.keys(r.season_counts).forEach(k => {
                    const n = Number(r.season_counts[k]) || 0;
                    e.counts[k] = n; e.total += n;
                });
            }
            dir.airports.push(e);
            dir.airportByCode[e.code] = e;
        });

        const metroName = {};
        metroRows.forEach(m => { if (m.metro_code) metroName[m.metro_code] = m.display_name; });
        const membersByMetro = {};
        dir.airports.forEach(a => { if (a.metroCode) (membersByMetro[a.metroCode] = membersByMetro[a.metroCode] || []).push(a); });

        Object.keys(membersByMetro).forEach(code => {
            if (!metroName[code]) return;           // metro_code with no metros row: treat airports individually
            const m = makeEntry('metro', code, metroName[code]);
            m.members = membersByMetro[code];
            m.members.forEach(a => {
                Object.keys(a.counts).forEach(k => { m.counts[k] = (m.counts[k] || 0) + a.counts[k]; });
                m.total += a.total;
            });
            dir.metros.push(m);
            dir.metroByCode[code] = m;
        });
        dir.loaded = true;
    }

    function load(baseUrl) {
        if (loadPromise) return loadPromise;
        loadPromise = (async () => {
            const metrosP = fetchAllRows(`${baseUrl}/metros?select=metro_code,display_name&order=metro_code.asc`);
            let rows, seasonAware = true;
            try {
                rows = await fetchAllRows(`${baseUrl}/airport_directory?select=airport_code,display_name,metro_code,season_counts&order=airport_code.asc`);
                if (!rows.length) throw new Error('airport_directory is empty');
            } catch (e) {
                console.warn('[airport-picker] airport_directory unavailable — falling back to airports table (no year filtering).', e);
                seasonAware = false;
                rows = await fetchAllRows(`${baseUrl}/airports?select=airport_code,display_name,metro_code&order=airport_code.asc`);
            }
            build(rows, await metrosP, seasonAware);
            pickers.forEach(p => p._revalidate());
        })();
        loadPromise.catch(() => { loadPromise = null; });   // allow a retry after a failure
        return loadPromise;
    }

    // ── Matching ───────────────────────────────────────────────────────
    function servedIn(e, season) {
        if (!season || !dir.seasonAware) return true;
        return (e.counts[season] || 0) > 0;
    }
    function weight(e, season) {
        return (season && dir.seasonAware) ? (e.counts[season] || 0) : e.total;
    }
    // 0 exact code · 1 name or code starts with query · 2 every query word starts a name word · 3 substring (3+ chars)
    function tierFor(e, q, qWords) {
        if (e.codeLc === q) return 0;
        if (e.nameLc.startsWith(q) || e.codeLc.startsWith(q)) return 1;
        if (qWords.length && qWords.every(w => e.words.some(x => x.startsWith(w)))) return 2;
        if (q.length >= 3 && e.nameLc.includes(q)) return 3;
        return null;
    }

    function rawMatches(text, opts, season) {
        const q = norm(text);
        if (!q) return [];
        const qWords = wordsOf(text);
        const pool = opts.allowMetros ? dir.metros.concat(dir.airports) : dir.airports;
        const hits = [];
        pool.forEach(e => {
            if (!servedIn(e, season)) return;
            const t = tierFor(e, q, qWords);
            if (t !== null) hits.push({ e, t });
        });
        hits.sort((a, b) =>
            (a.t - b.t) ||
            (weight(b.e, season) - weight(a.e, season)) ||
            (a.e.type === b.e.type ? 0 : a.e.type === 'metro' ? -1 : 1) ||
            a.e.label.localeCompare(b.e.label));
        return hits;
    }

    // Ranked rows for the dropdown; a metro is followed by its member airports.
    function search(text, opts, season) {
        const hits = rawMatches(text, opts, season);
        const rows = [], used = new Set();
        const push = (e, member) => {
            const key = e.type + ':' + e.code;
            if (used.has(key)) return;
            used.add(key); rows.push({ e, member });
        };
        hits.forEach(({ e }) => {
            if (rows.length >= MAX_SHOWN) return;
            if (e.type === 'metro') {
                push(e, false);
                e.members.filter(a => servedIn(a, season))
                    .sort((a, b) => weight(b, season) - weight(a, season))
                    .forEach(a => push(a, true));
            } else {
                push(e, false);
            }
        });
        return rows.slice(0, MAX_SHOWN + 4);
    }

    function exactMatch(text, opts, season) {
        const q = norm(text);
        if (!q) return null;
        const cands = (opts.allowMetros ? dir.metros : []).concat(dir.airports);
        // exact code, then exact full display name, then exact label
        return cands.find(e => e.codeLc === q && servedIn(e, season))
            || cands.find(e => norm(e.name) === q && servedIn(e, season))
            || cands.find(e => e.nameLc === q && servedIn(e, season))
            || null;
    }
    function exactMatchAnySeason(text, opts) {
        const q = norm(text);
        if (!q) return null;
        const cands = (opts.allowMetros ? dir.metros : []).concat(dir.airports);
        return cands.find(e => e.codeLc === q) || cands.find(e => norm(e.name) === q) || cands.find(e => e.nameLc === q) || null;
    }

    // ── Styles (injected once) ─────────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('ap-styles')) return;
        const css = `
.ap-wrap{position:relative;width:100%;}
.ap-list{position:absolute;left:0;right:0;top:calc(100% + 2px);z-index:60;max-height:330px;overflow-y:auto;margin:0;padding:3px 0;list-style:none;background:#fffdf8;border:1px solid #bda874;border-radius:2px;box-shadow:3px 4px 0 rgba(120,100,60,.16);font-family:'JetBrains Mono','Consolas','Courier New',monospace;text-transform:none;text-align:left;}
.ap-list[hidden]{display:none;}
.ap-opt{display:flex;align-items:baseline;gap:10px;padding:6px 10px;cursor:pointer;font-size:12.5px;font-weight:400;color:#2b2317;line-height:1.35;}
.ap-opt.active,.ap-opt:hover{background:#f1e4cf;}
.ap-code{flex:0 0 3.4em;font-weight:700;color:#bf360c;letter-spacing:.5px;}
.ap-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ap-meta{flex-shrink:0;font-size:9.5px;color:#9a8f70;text-transform:uppercase;letter-spacing:.5px;}
.ap-metro .ap-name{font-weight:700;}
.ap-member{padding-left:26px;}
.ap-member .ap-code{flex-basis:3.4em;}
.ap-empty{padding:8px 10px;font-size:12px;font-style:italic;color:#6d6247;cursor:default;line-height:1.5;}
.ap-note{margin-top:4px;font-size:10.5px;font-weight:700;color:#a3281a;line-height:1.4;text-transform:none;letter-spacing:.2px;}
.ap-note[hidden]{display:none;}
input.ap-invalid{border-color:#a3281a !important;}
`;
        const st = document.createElement('style');
        st.id = 'ap-styles';
        st.textContent = css;
        document.head.appendChild(st);
    }

    // ── Picker instance ────────────────────────────────────────────────
    let uid = 0;
    function attach(input, options) {
        injectStyles();
        const opts = Object.assign({ allowMetros: true, role: 'airport', onChange: null }, options || {});
        const id = input.id || ('ap-input-' + (++uid));
        input.id = id;

        let season = '', seasonLabel = '';
        let selection = null;
        let rows = [];
        let active = -1;

        input.removeAttribute('list');
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');

        const wrap = document.createElement('div');
        wrap.className = 'ap-wrap';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);

        const list = document.createElement('ul');
        list.className = 'ap-list';
        list.id = id + '-ap-list';
        list.setAttribute('role', 'listbox');
        list.hidden = true;
        wrap.appendChild(list);
        input.setAttribute('aria-controls', list.id);

        const note = document.createElement('div');
        note.className = 'ap-note';
        note.id = id + '-ap-note';
        note.setAttribute('role', 'status');
        note.hidden = true;
        wrap.appendChild(note);

        function setNote(msg) {
            if (msg) { note.textContent = msg; note.hidden = false; input.classList.add('ap-invalid'); input.setAttribute('aria-describedby', note.id); }
            else { note.textContent = ''; note.hidden = true; input.classList.remove('ap-invalid'); input.removeAttribute('aria-describedby'); }
        }
        function yearText() { return seasonLabel || season || 'that year'; }

        function close() {
            list.hidden = true; active = -1;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        }

        function render() {
            const text = input.value;
            if (!norm(text)) { rows = []; close(); return; }
            if (!dir.loaded) {
                rows = [];
                list.innerHTML = '<li class="ap-empty">Loading airports&hellip;</li>';
                list.hidden = false; input.setAttribute('aria-expanded', 'true');
                return;
            }
            rows = search(text, opts, season);
            if (!rows.length) {
                let msg = `No airports match &ldquo;${escHtml(text.trim())}&rdquo;`;
                if (season && dir.seasonAware) {
                    const other = rawMatches(text, opts, '');
                    msg = other.length
                        ? `${escHtml(other[0].e.label)} (${escHtml(other[0].e.code)}) has no flights in the ${escHtml(yearText())} schedules.`
                        : `${msg} in ${escHtml(yearText())}.`;
                }
                list.innerHTML = `<li class="ap-empty">${msg}</li>`;
                active = -1;
            } else {
                if (active >= rows.length) active = rows.length - 1;
                list.innerHTML = rows.map((r, i) => {
                    const e = r.e;
                    const cls = ['ap-opt', e.type === 'metro' ? 'ap-metro' : '', r.member ? 'ap-member' : '', i === active ? 'active' : ''].join(' ');
                    let meta = '';
                    if (e.type === 'metro') {
                        const n = e.members.filter(a => servedIn(a, season)).length;
                        meta = `All ${n} airport${n === 1 ? '' : 's'}`;
                    }
                    return `<li role="option" id="${id}-opt-${i}" class="${cls}" data-i="${i}" aria-selected="${i === active}">` +
                        `<span class="ap-code">${escHtml(e.code)}</span><span class="ap-name">${escHtml(e.label)}</span>` +
                        (meta ? `<span class="ap-meta">${meta}</span>` : '') + `</li>`;
                }).join('');
            }
            list.hidden = false;
            input.setAttribute('aria-expanded', 'true');
            if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-opt-${active}`);
            else input.removeAttribute('aria-activedescendant');
        }

        function setActive(i) {
            if (!rows.length) return;
            active = (i + rows.length) % rows.length;
            list.querySelectorAll('.ap-opt').forEach((el, j) => {
                el.classList.toggle('active', j === active);
                el.setAttribute('aria-selected', j === active);
            });
            const el = list.querySelector(`[data-i="${active}"]`);
            if (el) el.scrollIntoView({ block: 'nearest' });
            input.setAttribute('aria-activedescendant', `${id}-opt-${active}`);
        }

        function choose(e, silent) {
            selection = e;
            input.value = e ? e.name : '';
            close();
            validate();
            if (!silent && typeof opts.onChange === 'function') opts.onChange(selection);
        }

        // Selected airport not served in the chosen year -> flag (keep it; user decides)
        function validate() {
            if (selection && season && dir.seasonAware && !servedIn(selection, season)) {
                setNote(`No flights at ${selection.label}${selection.type === 'airport' ? ' (' + selection.code + ')' : ''} in the ${yearText()} schedules.`);
                return false;
            }
            setNote('');
            return true;
        }

        // ── events
        input.addEventListener('input', () => {
            selection = null; active = -1; setNote('');
            render();
            if (rows.length) setActive(0);
        });
        input.addEventListener('focus', () => {
            if (selection) { try { input.select(); } catch (_) {} }
            else if (norm(input.value)) { render(); if (rows.length) setActive(0); }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => {
                close();
                if (!selection && norm(input.value) && dir.loaded) {
                    const m = exactMatch(input.value, opts, season);
                    if (m) choose(m);
                    else setNote(`Choose ${opts.role === 'airport' ? 'an airport' : 'a ' + opts.role} from the list.`);
                }
            }, 120);
        });
        input.addEventListener('keydown', ev => {
            const open = !list.hidden && rows.length > 0;
            if (ev.key === 'ArrowDown') {
                ev.preventDefault();
                if (list.hidden) { render(); setActive(0); } else setActive(active + 1);
            } else if (ev.key === 'ArrowUp') {
                if (open) { ev.preventDefault(); setActive(active - 1); }
            } else if (ev.key === 'Enter') {
                if (open) { ev.preventDefault(); choose(rows[active >= 0 ? active : 0].e); }
            } else if (ev.key === 'Tab') {
                if (open && active >= 0) choose(rows[active].e);
            } else if (ev.key === 'Escape') {
                if (!list.hidden) { ev.preventDefault(); close(); }
            }
        });
        list.addEventListener('mousedown', ev => ev.preventDefault());   // keep focus in the input
        list.addEventListener('click', ev => {
            const li = ev.target.closest('.ap-opt');
            if (!li) return;
            const r = rows[Number(li.dataset.i)];
            if (r) choose(r.e);
        });

        const api = {
            input,
            get selection() { return selection; },
            setSeason(code, label) {
                season = code || ''; seasonLabel = label || '';
                validate();
                if (!list.hidden) render();
            },
            /* Selected entry if valid; otherwise tries an exact code/name match on the typed
               text, else flags the field and returns null. */
            resolve() {
                if (!selection && norm(input.value) && dir.loaded) {
                    const m = exactMatch(input.value, opts, season);
                    if (m) choose(m, true);
                }
                if (!selection) {
                    if (!norm(input.value)) setNote(`Enter ${opts.role === 'airport' ? 'an airport' : 'a ' + opts.role}.`);
                    else {
                        const other = season && dir.seasonAware ? exactMatchAnySeason(input.value, opts) : null;
                        setNote(other ? `No flights at ${other.label} in the ${yearText()} schedules.`
                            : `Choose ${opts.role === 'airport' ? 'an airport' : 'a ' + opts.role} from the list.`);
                    }
                    return null;
                }
                return validate() ? selection : null;
            },
            hasText() { return !!norm(input.value); },
            codes() {
                if (!selection) return [];
                return selection.type === 'metro' ? selection.members.map(a => a.code) : [selection.code];
            },
            filterParam(field) {
                const c = api.codes();
                if (!c.length) return null;
                return c.length === 1
                    ? `${field}_code=eq.${encodeURIComponent(c[0])}`
                    : `${field}_code=in.(${c.map(encodeURIComponent).join(',')})`;
            },
            displayName() { return selection ? selection.name : input.value.trim(); },
            clear() { selection = null; input.value = ''; close(); setNote(''); },
            /* For deep links / old URLs: code, exact name, or best-ranked match. */
            setFromText(text) {
                if (!dir.loaded || !norm(text)) return null;
                const m = exactMatch(text, opts, season) || (search(text, opts, season)[0] || {}).e || null;
                if (m) choose(m, true); else { input.value = text; selection = null; }
                return m;
            },
            focus() { input.focus(); },
            _setSelectionRaw(sel, text) { selection = sel; input.value = text; close(); validate(); },
            _revalidate() { validate(); }
        };
        pickers.push(api);
        return api;
    }

    function swap(a, b) {
        const sa = a.selection, ta = a.input.value;
        const sb = b.selection, tb = b.input.value;
        a._setSelectionRaw(sb, tb);
        b._setSelectionRaw(sa, ta);
    }

    window.AirportPicker = { load, attach, swap, _dir: dir, _search: search };
})();
