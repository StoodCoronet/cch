// Session picker TUI: a searchable blessed list of the daemon's sessions
// (running and exited). Enter resolves with the chosen session; q/Esc/Ctrl+C
// resolve with null. What happens next (attach vs resume) is the caller's job.
//
// Keyboard model: the search box is conceptually always focused, so every
// printable character (including j/k/q) filters the list. ↑/↓ always navigate.
// While the filter is EMPTY, j/k also navigate and q quits — once you type,
// those keys become literal search input until the filter is cleared again.
const blessed = require('blessed');

function formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Last two path segments, e.g. "self_host_happy/cli" — enough to recognize the project.
function cwdTail(cwd) {
    const parts = String(cwd || '').split('/').filter(Boolean);
    return parts.slice(-2).join('/');
}

function displayName(s) {
    return s.title || (s.claudeSessionId ? s.claudeSessionId.slice(0, 8) : String(s.sessionId).slice(0, 12));
}

// pickSession(sessions) -> Promise<session | null>
function pickSession(sessions) {
    return new Promise((resolve) => {
        const screen = blessed.screen({
            smartCSR: true,
            title: 'ccd — Select Session',
        });

        let query = '';
        let selected = 0;

        const searchBox = blessed.text({
            top: 0,
            left: 0,
            width: '100%',
            height: 1,
            tags: true,
        });

        const list = blessed.list({
            top: 1,
            left: 0,
            width: '100%',
            height: '100%-2',
            border: { type: 'line' },
            tags: true,
            style: {
                selected: { bg: 'blue', fg: 'white' },
                item: { fg: 'white' },
            },
        });

        const footer = blessed.text({
            bottom: 0,
            left: 0,
            width: '100%',
            height: 1,
            tags: true,
            style: { fg: 'gray' },
            content: ' [↑↓/jk] Navigate  [Enter] Attach/Resume  [type to search]  [q/Esc] Quit',
        });

        screen.append(searchBox);
        screen.append(list);
        screen.append(footer);

        function filteredSessions() {
            if (!query) return sessions;
            const q = query.toLowerCase();
            return sessions.filter(s =>
                (s.title || '').toLowerCase().includes(q) ||
                (s.profile || '').toLowerCase().includes(q) ||
                (s.cwd || '').toLowerCase().includes(q) ||
                String(s.sessionId || '').toLowerCase().includes(q) ||
                (s.claudeSessionId || '').toLowerCase().includes(q));
        }

        function render() {
            searchBox.setContent(` {bold}Search:{/bold} ${query}█`);
            const filtered = filteredSessions();
            if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
            if (!sessions.length) {
                list.setItems(['{gray-fg}No sessions. Spawn one first, or press q to quit.{/gray-fg}']);
            } else if (!filtered.length) {
                list.setItems([`{gray-fg}No sessions matching "${query}".{/gray-fg}`]);
            } else {
                list.setItems(filtered.map(s => {
                    const icon = s.state === 'running' ? '{green-fg}●{/green-fg}' : '{gray-fg}○{/gray-fg}';
                    const meta = `{gray-fg}${s.profile}  ${cwdTail(s.cwd)}  ${formatTime(s.createdAt)}{/gray-fg}`;
                    return `${icon} ${displayName(s)}  ${meta}`;
                }));
                list.select(selected);
            }
            screen.render();
        }

        function done(result) {
            screen.destroy();
            resolve(result);
        }

        screen.on('keypress', (ch, key) => {
            if (!key) return;
            const name = key.name;
            if (name === 'escape' || (key.ctrl && name === 'c')) return done(null);
            if (name === 'enter') {
                const filtered = filteredSessions();
                if (!filtered.length) return;
                return done(filtered[selected]);
            }
            if (name === 'up' || (name === 'k' && !query)) {
                const filtered = filteredSessions();
                if (filtered.length) selected = (selected - 1 + filtered.length) % filtered.length;
                return render();
            }
            if (name === 'down' || (name === 'j' && !query)) {
                const filtered = filteredSessions();
                if (filtered.length) selected = (selected + 1) % filtered.length;
                return render();
            }
            if (name === 'q' && !query) return done(null);
            if (name === 'backspace') {
                if (query) {
                    query = query.slice(0, -1);
                    selected = 0;
                }
                return render();
            }
            if (ch && ch.length === 1 && !key.ctrl && !key.meta && ch >= ' ') {
                query += ch;
                selected = 0;
                return render();
            }
        });

        render();
    });
}

module.exports = { pickSession };
