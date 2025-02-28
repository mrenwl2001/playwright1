/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isRegExp } from 'playwright-core/lib/utils';
import type { Reporter } from '../types/testReporter';
import type { SerializedLoaderData } from './ipc';
import type { BuiltInReporter, ConfigCLIOverrides } from './runner';
import { builtInReporters } from './runner';
import { requireOrImport } from './transform';
import type { Config, FullConfigInternal, FullProjectInternal, Project, ReporterDescription } from './types';
import { errorWithFile, getPackageJsonPath, mergeObjects } from './util';

export const defaultTimeout = 30000;

export class ConfigLoader {
  private _configCLIOverrides: ConfigCLIOverrides;
  private _fullConfig: FullConfigInternal;
  private _configDir: string = '';
  private _configFile: string | undefined;

  constructor(configCLIOverrides?: ConfigCLIOverrides) {
    this._configCLIOverrides = configCLIOverrides || {};
    this._fullConfig = { ...baseFullConfig };
  }

  static async deserialize(data: SerializedLoaderData): Promise<ConfigLoader> {
    const loader = new ConfigLoader(data.configCLIOverrides);
    if (data.configFile)
      await loader.loadConfigFile(data.configFile);
    else
      await loader.loadEmptyConfig(data.configDir);
    return loader;
  }

  async loadConfigFile(file: string): Promise<FullConfigInternal> {
    if (this._configFile)
      throw new Error('Cannot load two config files');
    const config = await this._requireOrImportDefaultObject(file) as Config;
    this._configFile = file;
    await this._processConfigObject(config, path.dirname(file));
    return this._fullConfig;
  }

  async loadEmptyConfig(configDir: string): Promise<Config> {
    await this._processConfigObject({}, configDir);
    return {};
  }

  private async _processConfigObject(config: Config, configDir: string) {
    // 1. Validate data provided in the config file.
    validateConfig(this._configFile || '<default config>', config);

    // 2. Override settings from CLI.
    config.forbidOnly = takeFirst(this._configCLIOverrides.forbidOnly, config.forbidOnly);
    config.fullyParallel = takeFirst(this._configCLIOverrides.fullyParallel, config.fullyParallel);
    config.globalTimeout = takeFirst(this._configCLIOverrides.globalTimeout, config.globalTimeout);
    config.maxFailures = takeFirst(this._configCLIOverrides.maxFailures, config.maxFailures);
    config.outputDir = takeFirst(this._configCLIOverrides.outputDir, config.outputDir);
    config.quiet = takeFirst(this._configCLIOverrides.quiet, config.quiet);
    config.repeatEach = takeFirst(this._configCLIOverrides.repeatEach, config.repeatEach);
    config.retries = takeFirst(this._configCLIOverrides.retries, config.retries);
    if (this._configCLIOverrides.reporter)
      config.reporter = toReporters(this._configCLIOverrides.reporter as any);
    config.shard = takeFirst(this._configCLIOverrides.shard, config.shard);
    config.timeout = takeFirst(this._configCLIOverrides.timeout, config.timeout);
    config.updateSnapshots = takeFirst(this._configCLIOverrides.updateSnapshots, config.updateSnapshots);
    config.ignoreSnapshots = takeFirst(this._configCLIOverrides.ignoreSnapshots, config.ignoreSnapshots);
    if (this._configCLIOverrides.projects && config.projects)
      throw new Error(`Cannot use --browser option when configuration file defines projects. Specify browserName in the projects instead.`);
    config.projects = takeFirst(this._configCLIOverrides.projects, config.projects as any);
    config.workers = takeFirst(this._configCLIOverrides.workers, config.workers);
    config.use = mergeObjects(config.use, this._configCLIOverrides.use);
    for (const project of config.projects || [])
      this._applyCLIOverridesToProject(project);

    // 3. Resolve config.
    this._configDir = configDir;
    const packageJsonPath = getPackageJsonPath(configDir);
    const packageJsonDir = packageJsonPath ? path.dirname(packageJsonPath) : undefined;
    const throwawayArtifactsPath = packageJsonDir || process.cwd();

    // Resolve script hooks relative to the root dir.
    if (config.globalSetup)
      config.globalSetup = resolveScript(config.globalSetup, configDir);
    if (config.globalTeardown)
      config.globalTeardown = resolveScript(config.globalTeardown, configDir);
    // Resolve all config dirs relative to configDir.
    if (config.testDir !== undefined)
      config.testDir = path.resolve(configDir, config.testDir);
    if (config.outputDir !== undefined)
      config.outputDir = path.resolve(configDir, config.outputDir);
    if (config.snapshotDir !== undefined)
      config.snapshotDir = path.resolve(configDir, config.snapshotDir);

    this._fullConfig._configDir = configDir;
    this._fullConfig._storeDir = path.resolve(configDir, '.playwright-store');
    this._fullConfig.configFile = this._configFile;
    this._fullConfig.rootDir = config.testDir || this._configDir;
    this._fullConfig._globalOutputDir = takeFirst(config.outputDir, throwawayArtifactsPath, baseFullConfig._globalOutputDir);
    this._fullConfig.forbidOnly = takeFirst(config.forbidOnly, baseFullConfig.forbidOnly);
    this._fullConfig.fullyParallel = takeFirst(config.fullyParallel, baseFullConfig.fullyParallel);
    this._fullConfig.globalSetup = takeFirst(config.globalSetup, baseFullConfig.globalSetup);
    this._fullConfig.globalTeardown = takeFirst(config.globalTeardown, baseFullConfig.globalTeardown);
    this._fullConfig.globalTimeout = takeFirst(config.globalTimeout, baseFullConfig.globalTimeout);
    this._fullConfig.grep = takeFirst(config.grep, baseFullConfig.grep);
    this._fullConfig.grepInvert = takeFirst(config.grepInvert, baseFullConfig.grepInvert);
    this._fullConfig.maxFailures = takeFirst(config.maxFailures, baseFullConfig.maxFailures);
    this._fullConfig.preserveOutput = takeFirst(config.preserveOutput, baseFullConfig.preserveOutput);
    this._fullConfig.reporter = takeFirst(resolveReporters(config.reporter, configDir), baseFullConfig.reporter);
    this._fullConfig.reportSlowTests = takeFirst(config.reportSlowTests, baseFullConfig.reportSlowTests);
    this._fullConfig.quiet = takeFirst(config.quiet, baseFullConfig.quiet);
    this._fullConfig.shard = takeFirst(config.shard, baseFullConfig.shard);
    this._fullConfig._ignoreSnapshots = takeFirst(config.ignoreSnapshots, baseFullConfig._ignoreSnapshots);
    this._fullConfig.updateSnapshots = takeFirst(config.updateSnapshots, baseFullConfig.updateSnapshots);

    const workers = takeFirst(config.workers, '50%');
    if (typeof workers === 'string') {
      if (workers.endsWith('%')) {
        const cpus = os.cpus().length;
        this._fullConfig.workers = Math.max(1, Math.floor(cpus * (parseInt(workers, 10) / 100)));
      } else {
        this._fullConfig.workers = parseInt(workers, 10);
      }
    } else {
      this._fullConfig.workers = workers;
    }

    const webServers = takeFirst(config.webServer, baseFullConfig.webServer);
    if (Array.isArray(webServers)) { // multiple web server mode
      // Due to previous choices, this value shows up to the user in globalSetup as part of FullConfig. Arrays are not supported by the old type.
      this._fullConfig.webServer = null;
      this._fullConfig._webServers = webServers;
    } else if (webServers) { // legacy singleton mode
      this._fullConfig.webServer = webServers;
      this._fullConfig._webServers = [webServers];
    }
    this._fullConfig.metadata = takeFirst(config.metadata, baseFullConfig.metadata);
    this._fullConfig.projects = (config.projects || [config]).map(p => this._resolveProject(config, this._fullConfig, p, throwawayArtifactsPath));
    this._assignUniqueProjectIds(this._fullConfig.projects);
  }

  private _assignUniqueProjectIds(projects: FullProjectInternal[]) {
    const usedNames = new Set();
    for (const p of projects) {
      const name = p.name || '';
      for (let i = 0; i < projects.length; ++i) {
        const candidate = name + (i ? i : '');
        if (usedNames.has(candidate))
          continue;
        p._id = candidate;
        usedNames.add(candidate);
        break;
      }
    }
  }

  async loadGlobalHook(file: string): Promise<(config: FullConfigInternal) => any> {
    return this._requireOrImportDefaultFunction(path.resolve(this._fullConfig.rootDir, file), false);
  }

  async loadReporter(file: string): Promise<new (arg?: any) => Reporter> {
    return this._requireOrImportDefaultFunction(path.resolve(this._fullConfig.rootDir, file), true);
  }

  fullConfig(): FullConfigInternal {
    return this._fullConfig;
  }

  serialize(): SerializedLoaderData {
    const result: SerializedLoaderData = {
      configFile: this._configFile,
      configDir: this._configDir,
      configCLIOverrides: this._configCLIOverrides,
    };
    return result;
  }

  private _applyCLIOverridesToProject(projectConfig: Project) {
    projectConfig.fullyParallel = takeFirst(this._configCLIOverrides.fullyParallel, projectConfig.fullyParallel);
    projectConfig.outputDir = takeFirst(this._configCLIOverrides.outputDir, projectConfig.outputDir);
    projectConfig.repeatEach = takeFirst(this._configCLIOverrides.repeatEach, projectConfig.repeatEach);
    projectConfig.retries = takeFirst(this._configCLIOverrides.retries, projectConfig.retries);
    projectConfig.timeout = takeFirst(this._configCLIOverrides.timeout, projectConfig.timeout);
    projectConfig.use = mergeObjects(projectConfig.use, this._configCLIOverrides.use);
  }

  private _resolveProject(config: Config, fullConfig: FullConfigInternal, projectConfig: Project, throwawayArtifactsPath: string): FullProjectInternal {
    // Resolve all config dirs relative to configDir.
    if (projectConfig.testDir !== undefined)
      projectConfig.testDir = path.resolve(this._configDir, projectConfig.testDir);
    if (projectConfig.outputDir !== undefined)
      projectConfig.outputDir = path.resolve(this._configDir, projectConfig.outputDir);
    if (projectConfig.snapshotDir !== undefined)
      projectConfig.snapshotDir = path.resolve(this._configDir, projectConfig.snapshotDir);

    const testDir = takeFirst(projectConfig.testDir, config.testDir, this._configDir);
    const respectGitIgnore = !projectConfig.testDir && !config.testDir;

    const outputDir = takeFirst(projectConfig.outputDir, config.outputDir, path.join(throwawayArtifactsPath, 'test-results'));
    const snapshotDir = takeFirst(projectConfig.snapshotDir, config.snapshotDir, testDir);
    const name = takeFirst(projectConfig.name, config.name, '');

    const defaultSnapshotPathTemplate = '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}';
    const snapshotPathTemplate = takeFirst(projectConfig.snapshotPathTemplate, config.snapshotPathTemplate, defaultSnapshotPathTemplate);
    return {
      _id: '',
      _fullConfig: fullConfig,
      _fullyParallel: takeFirst(projectConfig.fullyParallel, config.fullyParallel, undefined),
      _expect: takeFirst(projectConfig.expect, config.expect, {}),
      grep: takeFirst(projectConfig.grep, config.grep, baseFullConfig.grep),
      grepInvert: takeFirst(projectConfig.grepInvert, config.grepInvert, baseFullConfig.grepInvert),
      outputDir,
      repeatEach: takeFirst(projectConfig.repeatEach, config.repeatEach, 1),
      retries: takeFirst(projectConfig.retries, config.retries, 0),
      metadata: takeFirst(projectConfig.metadata, config.metadata, undefined),
      name,
      testDir,
      _respectGitIgnore: respectGitIgnore,
      snapshotDir,
      snapshotPathTemplate,
      testIgnore: takeFirst(projectConfig.testIgnore, config.testIgnore, []),
      testMatch: takeFirst(projectConfig.testMatch, config.testMatch, '**/?(*.)@(spec|test).*'),
      timeout: takeFirst(projectConfig.timeout, config.timeout, defaultTimeout),
      use: mergeObjects(config.use, projectConfig.use),
    };
  }

  private async _requireOrImportDefaultFunction(file: string, expectConstructor: boolean) {
    let func = await requireOrImport(file);
    if (func && typeof func === 'object' && ('default' in func))
      func = func['default'];
    if (typeof func !== 'function')
      throw errorWithFile(file, `file must export a single ${expectConstructor ? 'class' : 'function'}.`);
    return func;
  }

  private async _requireOrImportDefaultObject(file: string) {
    let object = await requireOrImport(file);
    if (object && typeof object === 'object' && ('default' in object))
      object = object['default'];
    return object;
  }
}

function takeFirst<T>(...args: (T | undefined)[]): T {
  for (const arg of args) {
    if (arg !== undefined)
      return arg;
  }
  return undefined as any as T;
}

function toReporters(reporters: BuiltInReporter | ReporterDescription[] | undefined): ReporterDescription[] | undefined {
  if (!reporters)
    return;
  if (typeof reporters === 'string')
    return [[reporters]];
  return reporters;
}

function validateConfig(file: string, config: Config) {
  if (typeof config !== 'object' || !config)
    throw errorWithFile(file, `Configuration file must export a single object`);

  validateProject(file, config, 'config');

  if ('forbidOnly' in config && config.forbidOnly !== undefined) {
    if (typeof config.forbidOnly !== 'boolean')
      throw errorWithFile(file, `config.forbidOnly must be a boolean`);
  }

  if ('globalSetup' in config && config.globalSetup !== undefined) {
    if (typeof config.globalSetup !== 'string')
      throw errorWithFile(file, `config.globalSetup must be a string`);
  }

  if ('globalTeardown' in config && config.globalTeardown !== undefined) {
    if (typeof config.globalTeardown !== 'string')
      throw errorWithFile(file, `config.globalTeardown must be a string`);
  }

  if ('globalTimeout' in config && config.globalTimeout !== undefined) {
    if (typeof config.globalTimeout !== 'number' || config.globalTimeout < 0)
      throw errorWithFile(file, `config.globalTimeout must be a non-negative number`);
  }

  if ('grep' in config && config.grep !== undefined) {
    if (Array.isArray(config.grep)) {
      config.grep.forEach((item, index) => {
        if (!isRegExp(item))
          throw errorWithFile(file, `config.grep[${index}] must be a RegExp`);
      });
    } else if (!isRegExp(config.grep)) {
      throw errorWithFile(file, `config.grep must be a RegExp`);
    }
  }

  if ('grepInvert' in config && config.grepInvert !== undefined) {
    if (Array.isArray(config.grepInvert)) {
      config.grepInvert.forEach((item, index) => {
        if (!isRegExp(item))
          throw errorWithFile(file, `config.grepInvert[${index}] must be a RegExp`);
      });
    } else if (!isRegExp(config.grepInvert)) {
      throw errorWithFile(file, `config.grepInvert must be a RegExp`);
    }
  }

  if ('maxFailures' in config && config.maxFailures !== undefined) {
    if (typeof config.maxFailures !== 'number' || config.maxFailures < 0)
      throw errorWithFile(file, `config.maxFailures must be a non-negative number`);
  }

  if ('preserveOutput' in config && config.preserveOutput !== undefined) {
    if (typeof config.preserveOutput !== 'string' || !['always', 'never', 'failures-only'].includes(config.preserveOutput))
      throw errorWithFile(file, `config.preserveOutput must be one of "always", "never" or "failures-only"`);
  }

  if ('projects' in config && config.projects !== undefined) {
    if (!Array.isArray(config.projects))
      throw errorWithFile(file, `config.projects must be an array`);
    config.projects.forEach((project, index) => {
      validateProject(file, project, `config.projects[${index}]`);
    });
  }

  if ('quiet' in config && config.quiet !== undefined) {
    if (typeof config.quiet !== 'boolean')
      throw errorWithFile(file, `config.quiet must be a boolean`);
  }

  if ('reporter' in config && config.reporter !== undefined) {
    if (Array.isArray(config.reporter)) {
      config.reporter.forEach((item, index) => {
        if (!Array.isArray(item) || item.length <= 0 || item.length > 2 || typeof item[0] !== 'string')
          throw errorWithFile(file, `config.reporter[${index}] must be a tuple [name, optionalArgument]`);
      });
    } else if (typeof config.reporter !== 'string') {
      throw errorWithFile(file, `config.reporter must be a string`);
    }
  }

  if ('reportSlowTests' in config && config.reportSlowTests !== undefined && config.reportSlowTests !== null) {
    if (!config.reportSlowTests || typeof config.reportSlowTests !== 'object')
      throw errorWithFile(file, `config.reportSlowTests must be an object`);
    if (!('max' in config.reportSlowTests) || typeof config.reportSlowTests.max !== 'number' || config.reportSlowTests.max < 0)
      throw errorWithFile(file, `config.reportSlowTests.max must be a non-negative number`);
    if (!('threshold' in config.reportSlowTests) || typeof config.reportSlowTests.threshold !== 'number' || config.reportSlowTests.threshold < 0)
      throw errorWithFile(file, `config.reportSlowTests.threshold must be a non-negative number`);
  }

  if ('shard' in config && config.shard !== undefined && config.shard !== null) {
    if (!config.shard || typeof config.shard !== 'object')
      throw errorWithFile(file, `config.shard must be an object`);
    if (!('total' in config.shard) || typeof config.shard.total !== 'number' || config.shard.total < 1)
      throw errorWithFile(file, `config.shard.total must be a positive number`);
    if (!('current' in config.shard) || typeof config.shard.current !== 'number' || config.shard.current < 1 || config.shard.current > config.shard.total)
      throw errorWithFile(file, `config.shard.current must be a positive number, not greater than config.shard.total`);
  }

  if ('ignoreSnapshots' in config && config.ignoreSnapshots !== undefined) {
    if (typeof config.ignoreSnapshots !== 'boolean')
      throw errorWithFile(file, `config.ignoreSnapshots must be a boolean`);
  }

  if ('updateSnapshots' in config && config.updateSnapshots !== undefined) {
    if (typeof config.updateSnapshots !== 'string' || !['all', 'none', 'missing'].includes(config.updateSnapshots))
      throw errorWithFile(file, `config.updateSnapshots must be one of "all", "none" or "missing"`);
  }

  if ('workers' in config && config.workers !== undefined) {
    if (typeof config.workers === 'number' && config.workers <= 0)
      throw errorWithFile(file, `config.workers must be a positive number`);
    else if (typeof config.workers === 'string' && !config.workers.endsWith('%'))
      throw errorWithFile(file, `config.workers must be a number or percentage`);
  }
}

function validateProject(file: string, project: Project, title: string) {
  if (typeof project !== 'object' || !project)
    throw errorWithFile(file, `${title} must be an object`);

  if ('name' in project && project.name !== undefined) {
    if (typeof project.name !== 'string')
      throw errorWithFile(file, `${title}.name must be a string`);
  }

  if ('outputDir' in project && project.outputDir !== undefined) {
    if (typeof project.outputDir !== 'string')
      throw errorWithFile(file, `${title}.outputDir must be a string`);
  }

  if ('repeatEach' in project && project.repeatEach !== undefined) {
    if (typeof project.repeatEach !== 'number' || project.repeatEach < 0)
      throw errorWithFile(file, `${title}.repeatEach must be a non-negative number`);
  }

  if ('retries' in project && project.retries !== undefined) {
    if (typeof project.retries !== 'number' || project.retries < 0)
      throw errorWithFile(file, `${title}.retries must be a non-negative number`);
  }

  if ('testDir' in project && project.testDir !== undefined) {
    if (typeof project.testDir !== 'string')
      throw errorWithFile(file, `${title}.testDir must be a string`);
  }

  for (const prop of ['testIgnore', 'testMatch'] as const) {
    if (prop in project && project[prop] !== undefined) {
      const value = project[prop];
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item !== 'string' && !isRegExp(item))
            throw errorWithFile(file, `${title}.${prop}[${index}] must be a string or a RegExp`);
        });
      } else if (typeof value !== 'string' && !isRegExp(value)) {
        throw errorWithFile(file, `${title}.${prop} must be a string or a RegExp`);
      }
    }
  }

  if ('timeout' in project && project.timeout !== undefined) {
    if (typeof project.timeout !== 'number' || project.timeout < 0)
      throw errorWithFile(file, `${title}.timeout must be a non-negative number`);
  }

  if ('use' in project && project.use !== undefined) {
    if (!project.use || typeof project.use !== 'object')
      throw errorWithFile(file, `${title}.use must be an object`);
  }
}

export const baseFullConfig: FullConfigInternal = {
  forbidOnly: false,
  fullyParallel: false,
  globalSetup: null,
  globalTeardown: null,
  globalTimeout: 0,
  grep: /.*/,
  grepInvert: null,
  maxFailures: 0,
  metadata: {},
  preserveOutput: 'always',
  projects: [],
  reporter: [[process.env.CI ? 'dot' : 'list']],
  reportSlowTests: { max: 5, threshold: 15000 },
  configFile: '',
  rootDir: path.resolve(process.cwd()),
  quiet: false,
  shard: null,
  updateSnapshots: 'missing',
  version: require('../package.json').version,
  workers: 0,
  webServer: null,
  _webServers: [],
  _globalOutputDir: path.resolve(process.cwd()),
  _configDir: '',
  _storeDir: '',
  _maxConcurrentTestGroups: 0,
  _ignoreSnapshots: false,
};

function resolveReporters(reporters: Config['reporter'], rootDir: string): ReporterDescription[]|undefined {
  return toReporters(reporters as any)?.map(([id, arg]) => {
    if (builtInReporters.includes(id as any))
      return [id, arg];
    return [require.resolve(id, { paths: [rootDir] }), arg];
  });
}

function resolveScript(id: string, rootDir: string) {
  const localPath = path.resolve(rootDir, id);
  if (fs.existsSync(localPath))
    return localPath;
  return require.resolve(id, { paths: [rootDir] });
}
