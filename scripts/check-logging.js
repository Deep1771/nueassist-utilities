'use strict';

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const sourceFiles = fs.readdirSync(projectRoot)
    .filter((fileName) => fileName.endsWith('.js'));
const violations = [];

for (const fileName of sourceFiles) {
    const filePath = path.join(projectRoot, fileName);
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*')) return;

        if (/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(line)) {
            violations.push(`${fileName}:${index + 1} uses console logging`);
        }
        if (/\b(?:logger|log)\.(?:error|warn|info|debug|event)\s*\(\s*`[^`]*\$\{/.test(line)) {
            violations.push(`${fileName}:${index + 1} interpolates data into a log message`);
        }
    });
}

if (violations.length) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exitCode = 1;
} else {
    process.stdout.write('Logging checks passed\n');
}
