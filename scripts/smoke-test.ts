/**
 * 全局安装冒烟测试
 * 模拟用户从远程安装后的实际使用场景，验证命令注册无冲突、基本功能可用
 *
 * 用法:
 *   bun run scripts/smoke-test.ts          # 从本地 dist 测试
 *   bun run scripts/smoke-test.ts --remote  # 从远程安装测试（push 后验证）
 */

const isRemote = process.argv.includes("--remote");

async function run(cmd: string): Promise<{ ok: boolean; output: string }> {
	try {
		const proc = Bun.spawn(["bash", "-c", cmd], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;
		return { ok: exitCode === 0, output: stdout + stderr };
	} catch (e) {
		return { ok: false, output: String(e) };
	}
}

interface TestCase {
	name: string;
	cmd: string;
	expectInOutput?: string;
	rejectInOutput?: string;
}

const tests: TestCase[] = [
	{
		name: "p --version 正常输出",
		cmd: "p --version",
	},
	{
		name: "p --help 正常输出，无报错",
		cmd: "p --help",
	},
	{
		name: "p t --help 指向 tag 命令",
		cmd: "p t --help",
		expectInOutput: "标签",
	},
	{
		name: "p tp --help 指向 template 命令",
		cmd: "p tp --help",
		expectInOutput: "模板",
	},
	{
		name: "p templates publish --help 正常输出",
		cmd: "p templates publish --help",
	},
];

let passed = 0;
let failed = 0;

for (const test of tests) {
	const { ok, output } = await run(test.cmd);

	let testPassed = ok;

	if (testPassed && test.expectInOutput && !output.includes(test.expectInOutput)) {
		testPassed = false;
	}

	if (testPassed && test.rejectInOutput && output.includes(test.rejectInOutput)) {
		testPassed = false;
	}

	if (testPassed) {
		console.log(`  ✓ ${test.name}`);
		passed++;
	} else {
		console.log(`  ✗ ${test.name}`);
		if (!ok) {
			const lines = output.trim().split("\n").slice(0, 3);
			for (const line of lines) console.log(`    ${line}`);
		}
		failed++;
	}
}

console.log(`\n  ${passed} passed, ${failed} failed`);

if (failed > 0) {
	process.exit(1);
}
