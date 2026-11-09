import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function createSessionWorktree(stateRoot, repository, id) {
    if (typeof repository !== 'string' || !path.isAbsolute(repository) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(repository))) {
        throw new Error('请选择本机 Git 仓库的绝对路径');
    }
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid worktree session id');
    const directory = await realpath(repository).catch(() => null);
    if (!directory || !(await stat(directory)).isDirectory()) throw new Error('Git 仓库目录不存在');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))), GIT_TERMINAL_PROMPT: '0' };
    async function git(cwd, args, timeout = 10000) {
        return (await run('git', ['-C', cwd, ...args], { env, windowsHide: true, timeout, maxBuffer: 128 * 1024 })).stdout.trim();
    }
    let repo;
    let commit;
    try {
        repo = await realpath(await git(directory, ['rev-parse', '--show-toplevel']));
        commit = await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error('未找到 Git，请先安装 Git');
        throw new Error('需要一个已有提交的 Git 工作区');
    }
    const root = path.join(stateRoot, 'work', 'worktrees');
    await mkdir(root, { recursive: true });
    const target = path.join(await realpath(root), id);
    const branch = `agent-dock/${id}`;
    try {
        // Create from a committed snapshot without touching the current checkout
        // or executing repository checkout hooks.
        const noHooks = process.platform === 'win32' ? 'NUL' : '/dev/null';
        await git(repo, ['-c', `core.hooksPath=${noHooks}`, 'worktree', 'add', '-b', branch, '--', target, commit], 45000);
    } catch (error) {
        const detail = error.stderr?.trim().split(/\r?\n/).at(-1)?.slice(0, 300);
        throw new Error(`创建 Git worktree 失败${detail ? '：' + detail : ''}`);
    }
    return { path: target, repo, branch, commit };
}
