const blessed = require('blessed');
const fs = require('fs');
const path = require('path');
const os = require('os');
const toml = require('toml');

const PROFILES_FILE = process.env.CCH_CONFIG || process.env.CCT_CONFIG ||
    path.join(os.homedir(), 'Library', 'Application Support', 'cc-happy', 'profiles.toml');

function loadProfiles() {
    if (!fs.existsSync(PROFILES_FILE)) return [];
    const content = fs.readFileSync(PROFILES_FILE, 'utf-8');
    const config = toml.parse(content);
    return (config.profiles || []).map(p => ({
        name: p.name,
        description: p.description || '',
        model: p.model || null,
        base_url: p.base_url || null,
        backend: p.backend || 'claude',
        env: p.env || {},
        skip_permissions: p.skip_permissions || false,
        extra_args: p.extra_args || [],
        full_auto: p.full_auto || null,
        auth_type: p.auth_type || null,
        max_context_size: p.max_context_size || null,
    }));
}

function pickProfileTUI(profiles) {
    return new Promise((resolve, reject) => {
        if (profiles.length === 0) {
            reject(new Error('No profiles found'));
            return;
        }

        // If PROFILE env var is set, use it directly
        if (process.env.PROFILE) {
            const found = profiles.find(p => p.name === process.env.PROFILE);
            if (found) {
                resolve(found);
                return;
            }
            reject(new Error(`Profile '${process.env.PROFILE}' not found`));
            return;
        }

        const screen = blessed.screen({
            smartCSR: true,
            title: 'ccd — Select Profile',
        });

        const backends = ['claude', 'codex', 'kimi'];
        let activeBackend = 0;
        let selected = 0;

        const tabBar = blessed.text({
            top: 0,
            left: 0,
            width: '100%',
            height: 1,
            tags: true,
        });

        const list = blessed.list({
            top: 1,
            left: 0,
            width: '35%',
            height: '100%-2',
            keys: true,
            vi: true,
            mouse: true,
            border: { type: 'line' },
            style: {
                selected: { bg: 'blue', fg: 'white' },
                item: { fg: 'white' },
            },
        });

        const detail = blessed.box({
            top: 1,
            left: '35%',
            width: '65%',
            height: '100%-2',
            border: { type: 'line' },
            scrollable: true,
            alwaysScroll: true,
        });

        const footer = blessed.text({
            bottom: 0,
            left: 0,
            width: '100%',
            height: 1,
            tags: true,
            style: { fg: 'gray' },
        });

        function renderFooter() {
            const backend = backends[activeBackend];
            let text = ' [Tab/1/2/3] Backend  [↑↓/jk] Navigate  [Enter] Launch';
            if (backend === 'claude') {
                text += '  [c] Resume  [s] Skip-perms  [t] Auth';
            } else if (backend === 'codex') {
                text += '  [s] Approval  [t] Auth';
            } else if (backend === 'kimi') {
                text += '  [Space] Context';
            }
            text += '  [a] Add  [d] Duplicate  [e] Edit  [q] Quit';
            footer.setContent(text);
        }

        screen.append(tabBar);
        screen.append(list);
        screen.append(detail);
        screen.append(footer);

        function renderTabBar() {
            const parts = backends.map((b, i) => {
                const label = `[${b.charAt(0).toUpperCase() + b.slice(1)}]`;
                return i === activeBackend ? `{blue-bg}{white-fg}{bold}${label}{/bold}{/white-fg}{/blue-bg}` : `{gray-fg}${label}{/gray-fg}`;
            });
            tabBar.setContent(parts.join('  '));
        }

        function renderList() {
            const filtered = profiles.filter(p => p.backend === backends[activeBackend]);
            const items = filtered.map(p => {
                let label = p.name;
                if (p.description) label += `\n  ${p.description}`;
                return label;
            });
            list.setItems(items.length ? items : ['No profiles. Press q to quit.']);
            list.select(Math.min(selected, items.length - 1));
            renderDetail();
        }

        function maskValue(key, val) {
            const upper = key.toUpperCase();
            if (upper.includes('TOKEN') || upper.includes('KEY') || upper.includes('SECRET')) {
                return '***';
            }
            return val;
        }

        function renderDetail() {
            const filtered = profiles.filter(p => p.backend === backends[activeBackend]);
            if (filtered.length === 0) {
                detail.setContent('No profiles');
                return;
            }
            const p = filtered[Math.min(selected, filtered.length - 1)];
            let content = `${p.description || p.name}\n\n`;
            if (p.model) content += `model: ${p.model}\n`;
            if (p.base_url) content += `base_url: ${p.base_url}\n`;

            if (p.backend === 'claude') {
                if (p.skip_permissions) content += `skip_permissions: ✓\n`;
                if (p.auth_type === 'token') content += `auth: token\n`;
            } else if (p.backend === 'codex') {
                const approval = p.full_auto === 'untrusted' ? 'untrusted' : p.full_auto === 'never' ? 'never' : p.full_auto === 'danger' ? 'danger' : 'on-request';
                content += `approval: ${approval}\n`;
                if (p.auth_type === 'subscription') content += `auth: subscription\n`;
            } else if (p.backend === 'kimi') {
                const effective = p.max_context_size || 'auto';
                content += `max_context_size: ${effective}\n`;
            }

            if (p.extra_args && p.extra_args.length) {
                content += `extra_args: ${p.extra_args.join(' ')}\n`;
            }

            if (p.env && Object.keys(p.env).length) {
                content += '\nENV:\n';
                const keys = Object.keys(p.env).sort();
                for (const k of keys) {
                    content += `  ${k} = ${maskValue(k, p.env[k])}\n`;
                }
            }

            detail.setContent(content);
        }

        function update() {
            renderTabBar();
            renderList();
            renderFooter();
            screen.render();
        }

        screen.key(['tab', '1', '2', '3'], (ch, key) => {
            if (key.name === 'tab') {
                activeBackend = (activeBackend + 1) % backends.length;
            } else {
                activeBackend = parseInt(ch, 10) - 1;
            }
            selected = 0;
            update();
        });

        screen.key(['up', 'k'], () => {
            const filtered = profiles.filter(p => p.backend === backends[activeBackend]);
            if (filtered.length === 0) return;
            selected = (selected - 1 + filtered.length) % filtered.length;
            update();
        });

        screen.key(['down', 'j'], () => {
            const filtered = profiles.filter(p => p.backend === backends[activeBackend]);
            if (filtered.length === 0) return;
            selected = (selected + 1) % filtered.length;
            update();
        });

        screen.key(['enter'], () => {
            const filtered = profiles.filter(p => p.backend === backends[activeBackend]);
            if (filtered.length === 0) return;
            screen.destroy();
            resolve(filtered[selected]);
        });

        screen.key(['c'], () => {
            const filtered = profiles.filter(p => p.backend === backends[activeBackend]);
            if (filtered.length === 0) return;
            // Resume: mark profile with continue flag
            const p = filtered[selected];
            screen.destroy();
            resolve({ ...p, _continue: true });
        });

        screen.key(['s'], () => {
            const filtered = profiles.filter(p => p.backend === backends[activeBackend]);
            if (filtered.length === 0) return;
            const p = filtered[selected];
            if (p.backend === 'claude') {
                p.skip_permissions = !p.skip_permissions;
            } else if (p.backend === 'codex') {
                const levels = ['untrusted', 'never', 'danger'];
                const current = levels.indexOf(p.full_auto || 'untrusted');
                p.full_auto = levels[(current + 1) % levels.length];
            }
            update();
        });

        screen.key(['q', 'C-c'], () => {
            screen.destroy();
            process.exit(0);
        });

        update();
    });
}

module.exports = { loadProfiles, pickProfileTUI };
