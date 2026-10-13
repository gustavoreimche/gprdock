import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Pipelines das contas do widget de Git: o último que você disparou em cada
// projeto mexido há pouco. Aqui fica só a consulta; quem mostra é o git.js.

const PROJECTS = 8;         // projetos mexidos por último, por conta
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ORDER = ['failed', 'running', 'ok', 'other'];
export const PIPELINE_MARKS = {failed: '✗', running: '◐', ok: '✓', other: '○'};

function gitlabState(status) {
    if (status === 'failed')
        return 'failed';
    if (status === 'success')
        return 'ok';
    return ['canceled', 'skipped', 'manual'].includes(status) ? 'other' : 'running';
}

function githubState(run) {
    if (run.status !== 'completed')
        return 'running';
    if (run.conclusion === 'success')
        return 'ok';
    return ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion) ? 'failed' : 'other';
}

// Um projeto que não responde (sem CI, sem permissão) só fica de fora; o
// cancelamento, que vem como erro de E/S, segue adiante.
async function each(projects, fetch, isCancelled) {
    const found = await Promise.all(projects.map(async project => {
        try {
            return await fetch(project);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            return null;
        }
    }));
    return found.filter(Boolean);
}

// `getJson(url, headers)` devolve o JSON da resposta e rejeita em erro; `api`
// é a raiz da API da conta. Devolve os pipelines dos últimos 7 dias, os que
// falharam primeiro: [{key, project, ref, state, url, time}].
export async function fetchPipelines(account, api, headers, getJson, isCancelled) {
    let pipelines = [];
    if (account.type === 'github') {
        const user = await getJson(`${api}/user`, headers);
        const repos = await getJson(`${api}/user/repos?sort=pushed&per_page=${PROJECTS}`, headers);
        pipelines = await each(repos, async repo => {
            const data = await getJson(`${api}/repos/${repo.full_name}/actions/runs` +
                `?per_page=1&actor=${encodeURIComponent(user.login)}`, headers);
            const run = data.workflow_runs?.[0];
            return run && {
                key: `${account.id}/${repo.full_name}`,
                project: repo.name,
                ref: run.head_branch,
                state: githubState(run),
                url: run.html_url,
                time: Date.parse(run.updated_at ?? run.created_at),
            };
        }, isCancelled);
    } else {
        const user = await getJson(`${api}/user`, headers);
        const projects = await getJson(`${api}/projects?membership=true&simple=true` +
            `&archived=false&order_by=last_activity_at&per_page=${PROJECTS}`, headers);
        pipelines = await each(projects, async project => {
            const [pipeline] = await getJson(`${api}/projects/${project.id}/pipelines` +
                `?per_page=1&username=${encodeURIComponent(user.username)}`, headers);
            return pipeline && {
                key: `${account.id}/${project.id}`,
                project: project.name,
                ref: pipeline.ref,
                state: gitlabState(pipeline.status),
                url: pipeline.web_url,
                time: Date.parse(pipeline.updated_at ?? pipeline.created_at),
            };
        }, isCancelled);
    }
    return pipelines.filter(p => Date.now() - p.time < MAX_AGE_MS)
        .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.time - a.time);
}

// Avisa de cada pipeline que passou a falhar. O que já se sabia fica guardado
// aqui, e não no widget: pode haver mais de um widget de Git consultando a
// mesma conta, e o aviso tem de sair uma vez só. A primeira consulta de uma
// conta só registra o estado, sem avisar do que já estava quebrado.
const known = new Map();        // pipeline -> estado e endereço
const seenAccounts = new Set();

export function announceFailures(accountId, pipelines) {
    const first = !seenAccounts.has(accountId);
    seenAccounts.add(accountId);
    for (const p of pipelines) {
        const now = `${p.state}@${p.url}`;
        if (!first && p.state === 'failed' && known.get(p.key) !== now)
            Main.notify('Pipeline falhou', `${p.project} · ${p.ref}`);
        known.set(p.key, now);
    }
}
