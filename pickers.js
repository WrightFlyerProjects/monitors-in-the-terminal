/* ═══════════════════════════════════════════════════════════════════════
   pickers.js — shared search fields for Monitors in the Terminal
   (replaces airport-picker.js) · used by index, browse-timetables, view-the-monitors

   AIRPORTS
     AirportPicker.load(SUPABASE_URL)                  -> Promise (loads once, shared)
     const p = AirportPicker.attach(inputEl, { allowMetros: true, role: 'origin' })
     AirportPicker.swap(pickerA, pickerB)
     AirportPicker.seasonFlightCounts()                -> { S88: 31234, ... } or null
     Data: airport_directory (per-season counts) · fallback: airports table

   AIRLINES
     AirlinePicker.load(SUPABASE_URL)
     const a = AirlinePicker.attach(inputEl, { role: 'airline' })
     Data: airline_directory (per-season counts) · fallback: airlines table
     Typing a fragment matched by several airlines also offers an
     'All "delta" airlines' row (e.g. Delta Air Lines + Delta Connection).

   Every picker instance
     p.setSeason(code, label)   p.resolve()   p.filterParam(field)   p.codes()
     p.displayName()            p.hasText()   p.clear()              p.setFromText(str)
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const PAGE = 1000;   // requested page size; paging stops on an empty page, so a lower server cap is still safe
    const MAX_SHOWN = 14;

    // ── Utilities ──────────────────────────────────────────────────────
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
    // PostgREST in.(…) list item: always double-quoted so commas/parentheses in names are safe
    function pgQuote(v) { return encodeURIComponent('"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'); }

    function readCounts(e, raw) {
        if (!raw) return;
        Object.keys(raw).forEach(k => { const n = Number(raw[k]) || 0; e.counts[k] = n; e.total += n; });
    }
    function sortHits(hits, weight) {
        hits.sort((a, b) =>
            (a.t - b.t) ||
            (weight(b.e) - weight(a.e)) ||
            (a.e.type === b.e.type ? 0 : (a.e.type === 'metro' ? -1 : 1)) ||
            a.e.label.localeCompare(b.e.label));
        return hits;
    }

    // ═══ AIRPORT SOURCE ═════════════════════════════════════════════════
    const airportDir = { loaded: false, seasonAware: false, airports: [], metros: [], airportByCode: {}, metroByCode: {} };

    // "Charleston, SC (CHS)" -> "Charleston, SC"   (list rows show the code in its own column)
    function stripCode(name, code) {
        if (!name) return code;
        const s = name.replace(new RegExp('\\s*\\(' + escRe(code) + '\\)\\s*$', 'i'), '');
        return s || name;
    }
    function makeAirportEntry(type, code, name) {
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
    function buildAirports(rows, metroRows, seasonAware) {
        const d = airportDir;
        d.airports = []; d.metros = []; d.airportByCode = {}; d.metroByCode = {};
        d.seasonAware = seasonAware;
        rows.forEach(r => {
            if (!r.airport_code || d.airportByCode[r.airport_code]) return;
            const e = makeAirportEntry('airport', r.airport_code, r.display_name);
            e.metroCode = r.metro_code || null;
            if (seasonAware) readCounts(e, r.season_counts);
            d.airports.push(e); d.airportByCode[e.code] = e;
        });
        const metroName = {};
        metroRows.forEach(m => { if (m.metro_code) metroName[m.metro_code] = m.display_name; });
        const membersByMetro = {};
        d.airports.forEach(a => { if (a.metroCode) (membersByMetro[a.metroCode] = membersByMetro[a.metroCode] || []).push(a); });
        Object.keys(membersByMetro).forEach(code => {
            if (!metroName[code]) return;   // metro_code with no metros row: airports stand alone
            const m = makeAirportEntry('metro', code, metroName[code]);
            m.members = membersByMetro[code];
            m.members.forEach(a => {
                Object.keys(a.counts).forEach(k => { m.counts[k] = (m.counts[k] || 0) + a.counts[k]; });
                m.total += a.total;
            });
            d.metros.push(m); d.metroByCode[code] = m;
        });
        d.loaded = true;
    }

    const airportSource = {
        noun: 'airport',
        dir: airportDir,
        isLoaded: () => airportDir.loaded,
        seasonAware: () => airportDir.seasonAware,
        servedIn(e, season) {
            if (!season || !airportDir.seasonAware) return true;
            return (e.counts[season] || 0) > 0;
        },
        weight(e, season) { return (season && airportDir.seasonAware) ? (e.counts[season] || 0) : e.total; },
        // 0 exact code · 1 name or code starts with query · 2 every query word starts a word · 3 substring (3+ chars)
        tier(e, q, qWords) {
            if (e.codeLc === q) return 0;
            if (e.nameLc.startsWith(q) || e.codeLc.startsWith(q)) return 1;
            if (qWords.length && qWords.every(w => e.words.some(x => x.startsWith(w)))) return 2;
            if (q.length >= 3 && e.nameLc.includes(q)) return 3;
            return null;
        },
        pool(opts) { return opts.allowMetros ? airportDir.metros.concat(airportDir.airports) : airportDir.airports; },
        rawMatches(text, opts, season) {
            const q = norm(text);
            if (!q) return [];
            const qWords = wordsOf(text), hits = [];
            this.pool(opts).forEach(e => {
                if (!this.servedIn(e, season)) return;
                const t = this.tier(e, q, qWords);
                if (t !== null) hits.push({ e, t });
            });
            return sortHits(hits, e => this.weight(e, season));
        },
        // Ranked dropdown rows; a metro is followed by its member airports.
        search(text, opts, season) {
            const rows = [], used = new Set();
            const push = (e, member) => { const k = e.type + ':' + e.code; if (!used.has(k)) { used.add(k); rows.push({ e, member }); } };
            this.rawMatches(text, opts, season).forEach(({ e }) => {
                if (rows.length >= MAX_SHOWN) return;
                push(e, false);
                if (e.type === 'metro') {
                    e.members.filter(a => this.servedIn(a, season))
                        .sort((a, b) => this.weight(b, season) - this.weight(a, season))
                        .forEach(a => push(a, true));
                }
            });
            return rows.slice(0, MAX_SHOWN + 4);
        },
        exactMatch(text, opts, season) {
            const q = norm(text);
            if (!q) return null;
            const c = this.pool(opts);   // metros first (matches dropdown ranking when a metro shares an airport's code, e.g. HOU)
            const ok = e => season === undefined || this.servedIn(e, season);
            return c.find(e => e.codeLc === q && ok(e)) || c.find(e => norm(e.name) === q && ok(e)) || c.find(e => e.nameLc === q && ok(e)) || null;
        },
        rowHtml(r, season) {
            const e = r.e;
            let meta = '';
            if (e.type === 'metro') {
                const n = e.members.filter(a => this.servedIn(a, season)).length;
                meta = `All ${n} airport${n === 1 ? '' : 's'}`;
            }
            return `<span class="ap-code">${escHtml(e.code)}</span><span class="ap-name">${escHtml(e.label)}</span>` +
                (meta ? `<span class="ap-meta">${meta}</span>` : '');
        },
        rowClass(r) { return (r.e.type === 'metro' ? 'ap-metro' : '') + (r.member ? ' ap-member' : ''); },
        describe(e) { return e.type === 'airport' ? `${e.label} (${e.code})` : e.label; },
        codes(e) { return e.type === 'metro' ? e.members.map(a => a.code) : [e.code]; },
        filterParam(field, e) {
            const c = this.codes(e);
            return c.length === 1
                ? `${field}_code=eq.${encodeURIComponent(c[0])}`
                : `${field}_code=in.(${c.map(encodeURIComponent).join(',')})`;
        }
    };

    let airportLoad = null;
    function loadAirports(baseUrl) {
        if (airportLoad) return airportLoad;
        airportLoad = (async () => {
            const metrosP = fetchAllRows(`${baseUrl}/metros?select=metro_code,display_name&order=metro_code.asc`);
            let rows, seasonAware = true;
            try {
                rows = await fetchAllRows(`${baseUrl}/airport_directory?select=airport_code,display_name,metro_code,season_counts&order=airport_code.asc`);
                if (!rows.length) throw new Error('airport_directory is empty');
            } catch (e) {
                console.warn('[pickers] airport_directory unavailable — falling back to airports table (no year filtering).', e);
                seasonAware = false;
                rows = await fetchAllRows(`${baseUrl}/airports?select=airport_code,display_name,metro_code&order=airport_code.asc`);
            }
            buildAirports(rows, await metrosP, seasonAware);
            instances.forEach(p => p._revalidate());
        })();
        airportLoad.catch(() => { airportLoad = null; });
        return airportLoad;
    }

    // Flights per season. Every flight is counted once at its origin and once at its
    // destination in airport_directory, so the per-season sum is halved.
    function seasonFlightCounts() {
        if (!airportDir.loaded || !airportDir.seasonAware) return null;
        const sums = {};
        airportDir.airports.forEach(a => Object.keys(a.counts).forEach(k => { sums[k] = (sums[k] || 0) + a.counts[k]; }));
        Object.keys(sums).forEach(k => { sums[k] = Math.round(sums[k] / 2); });
        return sums;
    }

    // ═══ AIRLINE SOURCE ═════════════════════════════════════════════════
    const airlineDir = { loaded: false, seasonAware: false, airlines: [] };

    function makeAirlineEntry(name) {
        return { type: 'airline', code: name, name, label: name, codeLc: '', nameLc: norm(name), words: wordsOf(name), counts: {}, total: 0 };
    }
    // 'All "delta" airlines' — every airline whose name contains the fragment, resolved against the current year when used
    function makeGroupEntry(query) {
        const q = query.trim();
        return { type: 'group', query: q, code: 'ALL', name: `All "${q}" airlines`, label: `All "${q}" airlines`, counts: {}, total: 0 };
    }

    const airlineSource = {
        noun: 'airline',
        dir: airlineDir,
        isLoaded: () => airlineDir.loaded,
        seasonAware: () => airlineDir.seasonAware,
        servedIn(e, season) {
            if (e.type === 'group') return this.groupMembers(e, season).length > 0;
            if (!season || !airlineDir.seasonAware) return true;
            return (e.counts[season] || 0) > 0;
        },
        weight(e, season) { return (season && airlineDir.seasonAware) ? (e.counts[season] || 0) : e.total; },
        // 0 exact name · 1 name starts with query · 2 every query word starts a word · 3 substring (3+ chars)
        tier(e, q, qWords) {
            if (e.nameLc === q) return 0;
            if (e.nameLc.startsWith(q)) return 1;
            if (qWords.length && qWords.every(w => e.words.some(x => x.startsWith(w)))) return 2;
            if (q.length >= 3 && e.nameLc.includes(q)) return 3;
            return null;
        },
        rawMatches(text, opts, season) {
            const q = norm(text);
            if (!q) return [];
            const qWords = wordsOf(text), hits = [];
            airlineDir.airlines.forEach(e => {
                if (!this.servedIn(e, season)) return;
                const t = this.tier(e, q, qWords);
                if (t !== null) hits.push({ e, t });
            });
            return sortHits(hits, e => this.weight(e, season));
        },
        groupMembers(g, season) {
            const q = norm(g.query);
            return airlineDir.airlines.filter(a => a.nameLc.includes(q) && (!season || !airlineDir.seasonAware || (a.counts[season] || 0) > 0));
        },
        search(text, opts, season) {
            const hits = this.rawMatches(text, opts, season);
            const rows = hits.slice(0, MAX_SHOWN).map(h => ({ e: h.e, member: false }));
            // Offer the family row when a 3+ character fragment hits several airlines
            if (norm(text).length >= 3) {
                const g = makeGroupEntry(text);
                if (this.groupMembers(g, season).length >= 2) rows.push({ e: g, member: false });
            }
            return rows;
        },
        exactMatch(text, opts, season) {
            const q = norm(text);
            if (!q) return null;
            const groupMatch = /^all "(.+)" airlines$/i.exec(String(text).trim());
            if (groupMatch) { const g = makeGroupEntry(groupMatch[1]); return (season === undefined || this.servedIn(g, season)) ? g : null; }
            return airlineDir.airlines.find(e => e.nameLc === q && (season === undefined || this.servedIn(e, season))) || null;
        },
        rowHtml(r, season) {
            const e = r.e;
            if (e.type === 'group') {
                const n = this.groupMembers(e, season).length;
                return `<span class="ap-name">All &ldquo;${escHtml(e.query)}&rdquo; airlines</span><span class="ap-meta">${n} carriers</span>`;
            }
            return `<span class="ap-name">${escHtml(e.label)}</span>`;
        },
        rowClass(r) { return r.e.type === 'group' ? 'ap-metro ap-group' : 'ap-airline'; },
        describe(e) { return e.label; },
        codes(e, season) { return e.type === 'group' ? this.groupMembers(e, season).map(a => a.name) : [e.name]; },
        filterParam(field, e, season) {
            const c = this.codes(e, season);
            return c.length === 1
                ? `${field}=eq.${encodeURIComponent(c[0])}`
                : `${field}=in.(${c.map(pgQuote).join(',')})`;
        }
    };

    let airlineLoad = null;
    function loadAirlines(baseUrl) {
        if (airlineLoad) return airlineLoad;
        airlineLoad = (async () => {
            let rows, seasonAware = true;
            try {
                rows = await fetchAllRows(`${baseUrl}/airline_directory?select=airline_name,season_counts&order=airline_name.asc`);
                if (!rows.length) throw new Error('airline_directory is empty');
            } catch (e) {
                console.warn('[pickers] airline_directory unavailable — falling back to airlines table (no year filtering).', e);
                seasonAware = false;
                rows = await fetchAllRows(`${baseUrl}/airlines?select=airline_name&order=airline_name.asc`);
            }
            airlineDir.airlines = [];
            const seen = new Set();
            rows.forEach(r => {
                if (!r.airline_name || seen.has(r.airline_name)) return;
                seen.add(r.airline_name);
                const e = makeAirlineEntry(r.airline_name);
                if (seasonAware) readCounts(e, r.season_counts);
                airlineDir.airlines.push(e);
            });
            airlineDir.seasonAware = seasonAware;
            airlineDir.loaded = true;
            instances.forEach(p => p._revalidate());
        })();
        airlineLoad.catch(() => { airlineLoad = null; });
        return airlineLoad;
    }

    // ═══ STYLES (injected once) ═════════════════════════════════════════
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
.ap-group{border-top:1px dotted #cdbd97;margin-top:2px;}
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

    // ═══ PICKER UI (shared by both sources) ═════════════════════════════
    const instances = [];
    let uid = 0;

    function attachPicker(src, input, options) {
        injectStyles();
        const opts = Object.assign({ allowMetros: true, role: src.noun, onChange: null }, options || {});
        const id = input.id || ('ap-input-' + (++uid));
        input.id = id;
        const article = /^[aeiou]/i.test(opts.role) ? 'an' : 'a';

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
            if (!src.isLoaded()) {
                rows = [];
                list.innerHTML = `<li class="ap-empty">Loading ${src.noun}s&hellip;</li>`;
                list.hidden = false; input.setAttribute('aria-expanded', 'true');
                return;
            }
            rows = src.search(text, opts, season);
            if (!rows.length) {
                let msg = `No ${src.noun}s match &ldquo;${escHtml(text.trim())}&rdquo;`;
                if (season && src.seasonAware()) {
                    const other = src.rawMatches(text, opts, '');
                    msg = other.length
                        ? `${escHtml(src.describe(other[0].e))} has no flights in the ${escHtml(yearText())} schedules.`
                        : `${msg} in ${escHtml(yearText())}.`;
                }
                list.innerHTML = `<li class="ap-empty">${msg}</li>`;
                active = -1;
            } else {
                if (active >= rows.length) active = rows.length - 1;
                list.innerHTML = rows.map((r, i) =>
                    `<li role="option" id="${id}-opt-${i}" class="ap-opt ${src.rowClass(r)}${i === active ? ' active' : ''}" data-i="${i}" aria-selected="${i === active}">` +
                    src.rowHtml(r, season) + `</li>`).join('');
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

        // Selection not served in the chosen year -> flag it (kept; the user decides)
        function validate() {
            if (selection && season && src.seasonAware() && !src.servedIn(selection, season)) {
                setNote(`No flights ${selection.type === 'group' ? 'for any airline matching "' + selection.query + '"' : (src.noun === 'airport' ? 'at ' : 'on ') + src.describe(selection)} in the ${yearText()} schedules.`);
                return false;
            }
            setNote('');
            return true;
        }

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
                if (!selection && norm(input.value) && src.isLoaded()) {
                    const m = src.exactMatch(input.value, opts, season);
                    if (m) choose(m);
                    else setNote(`Choose ${article} ${opts.role} from the list.`);
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
            /* Selected entry if valid for the year; otherwise tries an exact match on the
               typed text, else flags the field and returns null. */
            resolve() {
                if (!selection && norm(input.value) && src.isLoaded()) {
                    const m = src.exactMatch(input.value, opts, season);
                    if (m) choose(m, true);
                }
                if (!selection) {
                    if (!norm(input.value)) setNote(`Enter ${article} ${opts.role}.`);
                    else {
                        const other = (season && src.seasonAware()) ? src.exactMatch(input.value, opts, undefined) : null;
                        setNote(other ? `No flights ${src.noun === 'airport' ? 'at' : 'on'} ${src.describe(other)} in the ${yearText()} schedules.`
                            : `Choose ${article} ${opts.role} from the list.`);
                    }
                    return null;
                }
                return validate() ? selection : null;
            },
            hasText() { return !!norm(input.value); },
            codes() { return selection ? src.codes(selection, season) : []; },
            filterParam(field) { return selection ? src.filterParam(field, selection, season) : null; },
            displayName() { return selection ? selection.name : input.value.trim(); },
            clear() { selection = null; input.value = ''; close(); setNote(''); },
            /* For deep links / old URLs: exact match, else best-ranked match. */
            setFromText(text) {
                if (!src.isLoaded() || !norm(text)) return null;
                const m = src.exactMatch(text, opts, season) || (src.search(text, opts, season)[0] || {}).e || null;
                if (m) choose(m, true); else { input.value = text; selection = null; }
                return m;
            },
            focus() { input.focus(); },
            _setSelectionRaw(sel, text) { selection = sel; input.value = text; close(); validate(); },
            _revalidate() { validate(); }
        };
        instances.push(api);
        return api;
    }

    function swap(a, b) {
        const sa = a.selection, ta = a.input.value;
        const sb = b.selection, tb = b.input.value;
        a._setSelectionRaw(sb, tb);
        b._setSelectionRaw(sa, ta);
    }

    window.AirportPicker = {
        load: loadAirports,
        attach: (input, options) => attachPicker(airportSource, input, options),
        swap, seasonFlightCounts,
        _dir: airportDir, _search: (t, o, s) => airportSource.search(t, o, s)
    };
    window.AirlinePicker = {
        load: loadAirlines,
        attach: (input, options) => attachPicker(airlineSource, input, options),
        _dir: airlineDir
    };
})();
