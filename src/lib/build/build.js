'use strict';

const path = require('path');
const debug = require('debug')('fun:build');
const fs = require('fs-extra');
const yaml = require('js-yaml');
const nas = require('../nas');
const ncp = require('../utils/ncp');
const util = require('util');
const ncpAsync = util.promisify(ncp);
const taskflow = require('./taskflow');
const template = require('./template');
const artifact = require('./artifact');
const docker = require('../docker');
const uuid = require('uuid');
const parser = require('./parser');
const builder = require('./builder');
const fcBuilders = require('@alicloud/fc-builders');

const { yellow } = require('colors');
const { green, red } = require('colors');
const { recordMtimes } = require('../utils/file');
const { findFunctionsInTpl } = require('../definition');
const { DEFAULT_NAS_PATH_SUFFIX } = require('../tpl');

const _ = require('lodash');

async function convertFunYmlToFunfile(funymlPath, funfilePath) {
  const generatedFunfile = await parser.funymlToFunfile(funymlPath);

  await fs.writeFile(funfilePath, generatedFunfile);
}

async function convertFunfileToDockerfile(funfilePath, dockerfilePath, runtime, serviceName, functionName) {
  const dockerfileContent = await parser.funfileToDockerfile(funfilePath, runtime, serviceName, functionName);

  await fs.writeFile(dockerfilePath, dockerfileContent);
}

async function assertCodeUriExist(codeUri) {
  if (!(await fs.pathExists(codeUri))) {
    throw new Error(`CodeUri ${codeUri} is not exist.`);
  }
}

async function copyNasArtifact(nasMappings, imageTag, rootArtifactsDir, funcArtifactDir) {
  // if .fun/nas exist in funcArtifactDir , fun will move co rootartifactsDir
  const funcNasFolder = path.join(funcArtifactDir, DEFAULT_NAS_PATH_SUFFIX);
  const rootNasFolder = path.join(rootArtifactsDir, DEFAULT_NAS_PATH_SUFFIX);

  if (await fs.pathExists(funcNasFolder) && funcNasFolder !== rootNasFolder) {
    console.log(`moving ${funcNasFolder} to ${rootNasFolder}`);

    await fs.ensureDir(rootNasFolder);

    await ncpAsync(funcNasFolder, rootNasFolder);
    await fs.remove(funcNasFolder);
  }

  if (nasMappings) {
    for (let nasMapping of nasMappings) {
      const localNasDir = nasMapping.localNasDir;
      let remoteNasDir = nasMapping.remoteNasDir;

      if (!remoteNasDir.endsWith('/')) {
        remoteNasDir += '/';
      }

      try {
        console.log('copy from container ' + remoteNasDir + '.' + ' to localNasDir');
        await docker.copyFromImage(imageTag, remoteNasDir + '.', localNasDir);
      } catch (e) {
        debug(`copy from image ${imageTag} directory ${remoteNasDir} to ${localNasDir} error`, e);
      }
    }
  }
}

async function getOrConvertFunfile(codeUri) {
  const funfilePath = path.join(codeUri, 'Funfile');
  const funymlPath = path.join(codeUri, 'fun.yml');

  let funfileExist = await fs.pathExists(funfilePath);
  const funymlExist = await fs.pathExists(funymlPath);

  // convert funyml to Funfile if funyml exist and Funfile dont exist
  if (!funfileExist && funymlExist) {
    console.log('detecting fun.yml but no Funfile, Fun will convert fun.yml to Funfile');

    await convertFunYmlToFunfile(funymlPath, funfilePath);

    funfileExist = true;
  }

  if (funfileExist) {
    return funfilePath;
  }
  return null;
}

async function processFunfile(serviceName, serviceRes, codeUri, funfilePath, baseDir, funcArtifactDir, runtime, functionName) {
  console.log(yellow('Funfile exist, Fun will use container to build forcely'));

  const dockerfilePath = path.join(codeUri, '.Funfile.generated.dockerfile');
  await convertFunfileToDockerfile(funfilePath, dockerfilePath, runtime, serviceName, functionName);

  const nasConfig = (serviceRes.Properties || {}).NasConfig;
  let nasMappings;
  if (nasConfig) {
    nasMappings = await nas.convertNasConfigToNasMappings(nas.getDefaultNasDir(baseDir), nasConfig, serviceName);
  }

  const tag = `fun-cache-${uuid.v4()}`;
  const imageTag = await docker.buildImage(codeUri, dockerfilePath, tag);

  // copy fun install generated artifact files to artifact dir
  console.log(`copying function artifact to ${funcArtifactDir}`);
  await docker.copyFromImage(imageTag, '/code/.', funcArtifactDir);

  // process nas folder
  await copyNasArtifact(nasMappings, imageTag, baseDir, funcArtifactDir);
  await fs.remove(dockerfilePath);

  return imageTag;
}

const metaFiles = ['.', 'pom.xml', 'package.json', 'package-lock.json', 'requirements.txt', 'composer.json',
  path.join('src', 'main', 'java')
];

async function recordMetaData(baseDir, functions, tplPath, metaPath, buildOps) {

  const metaPaths = _.flatMap(functions, (func => {
    const { functionRes } = func;
    const codeUri = (functionRes.Properties || {}).CodeUri;

    const asbBaseDir = path.resolve(baseDir);

    let absCodeUri;

    if (!codeUri) {
      absCodeUri = asbBaseDir;
    } else {
      absCodeUri = path.resolve(baseDir, codeUri);
    }

    return metaFiles
      .map(metaFile => { return path.join(absCodeUri, metaFile); })
      .filter(metaFile => { return fs.pathExistsSync(metaFile); });
  }));

  await recordMtimes([...metaPaths, tplPath], buildOps, metaPath);
}

async function buildFunction(buildName, tpl, baseDir, useDocker, stages, verbose, tplPath) {
  const buildStage = _.includes(stages, 'build');

  if (useDocker) {
    console.log(green(`start ${buildStage ? 'building' : 'installing'} functions using docker`));
  } else {
    console.log(green(`start ${buildStage ? 'building' : 'installing'} function dependencies without docker`));
  }

  debug(`${buildStage ? 'buildName' : 'installName'}: ${buildName}`);

  const buildFuncs = template.findBuildFuncs(buildName, tpl);
  const skippedBuildFuncs = [];

  let rootArtifactsDir;
  if (buildStage) {
    rootArtifactsDir = await artifact.generateRootArtifactDirectory(baseDir);
    await artifact.cleanDirectory(rootArtifactsDir);
  } else {
    rootArtifactsDir = baseDir;
  }

  await detectFunFile(baseDir, tpl);

  for (let func of buildFuncs) {
    const { functionName, serviceName, serviceRes, functionRes } = func;

    console.log();
    console.log(green(`building ${serviceName}/${functionName}`));

    const runtime = functionRes.Properties.Runtime;
    const codeUri = functionRes.Properties.CodeUri;
    const absCodeUri = path.resolve(baseDir, functionRes.Properties.CodeUri);

    await assertCodeUriExist(absCodeUri);

    if (runtime === 'java8' && (absCodeUri.endsWith('.zip') || absCodeUri.endsWith('.jar') || absCodeUri.endsWith('.war'))) {
      console.warn(red(`\nDetectionWarning: your codeuri is '${codeUri}', and 'fun build' will not compile your functions. It is recommended that you modify ${serviceName}/${functionName}'s 'CodeUri' property to the directory where 'pom.xml' is located.`));
    }

    let funcArtifactDir;
    if (buildStage) {
      funcArtifactDir = await artifact.generateArtifactDirectory(rootArtifactsDir, serviceName, functionName);
      await artifact.cleanDirectory(funcArtifactDir);
    } else {
      funcArtifactDir = absCodeUri;
    }

    const Builder = fcBuilders.Builder;
    const taskFlows = await Builder.detectTaskFlow(runtime, absCodeUri);

    const funfilePath = await getOrConvertFunfile(absCodeUri);

    let imageTag;

    // convert Funfile to dockerfile if Funfile exist
    if (funfilePath) {
      imageTag = await processFunfile(serviceName, serviceRes, absCodeUri, funfilePath, baseDir, funcArtifactDir, runtime, functionName);
    }

    // For build stage, Fun needn't compile functions only if there are no manifest file and no Funfile.
    // For install stage, Fun needn't compile functions only if there are no manifest file.
    const manifestExist = !(_.isEmpty(taskFlows) || taskflow.isOnlyDefaultTaskFlow(taskFlows));

    if ((buildStage && (!funfilePath && !manifestExist))
      || (!buildStage && !manifestExist)) {
      debug(`could not find any manifest file for ${func.serviceName}/${func.functionName}, [${stages}] stage for manifest will be skipped`);
      skippedBuildFuncs.push(func);
      continue;
    }

    if (useDocker || funfilePath) { // force docker if funfilePath exist
      await builder.buildInDocker(serviceName, serviceRes, functionName, functionRes, baseDir, absCodeUri, funcArtifactDir, verbose, imageTag, stages);
    } else {
      await builder.buildInProcess(serviceName, functionName, absCodeUri, runtime, funcArtifactDir, verbose, stages);
    }
  }

  if (buildStage) {
    const updatedTemplateContent = template.updateTemplateResources(tpl, buildFuncs, skippedBuildFuncs, baseDir, rootArtifactsDir);

    await fs.writeFile(path.join(rootArtifactsDir, 'template.yml'), yaml.dump(updatedTemplateContent));
    // save meta data
    await recordMetaData(baseDir, buildFuncs, tplPath, path.resolve(rootArtifactsDir, 'meta.json'), {
      'useDocker': useDocker,
      'verbose': verbose,
      'buildName': buildName
    });

    console.log(green('\nBuild Success\n'));

    console.log('Built artifacts: ' + path.relative(baseDir, rootArtifactsDir));
    console.log('Built template: ' + path.relative(baseDir, path.join(rootArtifactsDir, 'template.yml')));
  } else {
    console.log(green('\nInstall Success\n'));
  }
}

async function detectFunFile(baseDir, tpl) {
  const funfilePath = path.join(baseDir, 'Funfile');
  if (await fs.pathExists(funfilePath)) {

    const codeUris = findFunctionsInTpl(tpl).map(func => {
      return path.resolve(baseDir, func.functionRes.Properties.CodeUri);
    });

    if (!_.includes(codeUris, baseDir)) {
      console.warn(red(`\nFun detected that the '${path.resolve(funfilePath)}' is not included in any CodeUri.\nPlease make sure if it is the right configuration. if yes, ignore please.`));
    }
  }
}

module.exports = {
  buildFunction, copyNasArtifact, getOrConvertFunfile
};