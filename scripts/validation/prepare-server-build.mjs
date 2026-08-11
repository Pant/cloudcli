import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const projectPath = path.resolve('server/tsconfig.json');
const config = ts.getParsedCommandLineOfConfigFile(projectPath, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic(diagnostic) {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  },
});

if (!config) {
  throw new Error(`Unable to read ${projectPath}`);
}

const expectedOutputs = config.fileNames.flatMap((fileName) =>
  ts.getOutputFileNames(config, fileName, false),
);
const missingOutput = expectedOutputs.find((outputPath) => !fs.existsSync(outputPath));

if (missingOutput) {
  const outputDirectory = path.resolve('dist-server');
  if (fs.existsSync(outputDirectory)) {
    for (const entry of fs.readdirSync(outputDirectory)) {
      fs.rmSync(path.join(outputDirectory, entry), { recursive: true, force: true });
    }
  }
  fs.rmSync(path.resolve('.build-backend.tsbuildinfo'), { force: true });
  console.log(`Server output is incomplete (${path.relative(process.cwd(), missingOutput)} is missing); rebuilding from a clean emitting cache.`);
}
