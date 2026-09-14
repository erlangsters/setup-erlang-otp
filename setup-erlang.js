//
// Copyright (c) 2024, Byteplug LLC.
//
// This source file is part of a project made by the Erlangsters community and
// is released under the MIT license. Please refer to the LICENSE.md file that
// can be found at the root of the project repository.
//
// Written by Jonathan De Wachter <jonathan.dewachter@byteplug.io>
//
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync, execFileSync } = require('child_process');
const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const exec = require('@actions/exec');

// XXX: Perhaps allow customizing where the pre-built Erlang/OTP binaries are
//      downloaded from.
// XXX: Detection of libc must be reworked to be more robust.

// By default, this is where we download the pre-built Erlang binaries.
const S3_ENDPOINT_URL = 'https://storage.erlangsters.org';
const S3_BUCKET_NAME = 'erlangsters';
const S3_PATH_PREFIX = 'erlang-otp';

// The supported Erlang/OTP versions, in descending order (important!).
const OTP_VERSIONS = [
  "29.0.6",
  "28.5.0.6",
  "27.3.4.17"
];

const REBAR3_DOWNLOAD_URL = "https://s3.amazonaws.com/rebar3/rebar3";

// Default Erlang version is the latest stable version, used when the Erlang
// version is not specified.
function defaultVersion() {
  return OTP_VERSIONS[0];
}

// Normalize the Erlang version by finding the latest version that matches the
// given version prefix. For example, if the specified version is "27", it will
// return "27.3.4.17".
function normalizeVersion(version) {
  const versionPrefix = version.toString();
  const matchingVersions = OTP_VERSIONS.filter(v => v.startsWith(versionPrefix));
  if (matchingVersions.length === 0) {
    throw new Error(`No matching versions found for ${version}`);
  }
  return matchingVersions[0];
}

// Detect the runner's OS and architecture so we can download the correct
// pre-built Erlang binaries.
function getRunnerOS() {
  const platform = os.platform();
  if (platform === 'linux') {
    return 'linux';
  } else if (platform === 'win32') {
    return 'windows';
  } else if (platform === 'darwin') {
    return 'macos';
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}
function getRunnerArchitecture() {
  const arch = os.arch();
  if (arch === 'x64') {
    return 'amd64';
  } else if (arch === 'arm64') {
    return 'arm64';
  } else {
    throw new Error(`Unsupported architecture: ${arch}`);
  }
}

// OTP 26 and later call sigaltstack with compile-time SIGSTKSZ (~8KiB). musl
// 1.2.6 rejects that when the runtime MINSIGSTKSZ is larger (AMX/AVX-512
// hosts). Trees are dynamically linked, so a 3.23 build is not safe on 1.2.6.
const MUSL_UNSUPPORTED_FROM = '1.2.6';
const OTP_SIGALTSTACK_MAJOR = 26;

function parseDottedVersion(version) {
  return version.split('.').map((part) => parseInt(part, 10) || 0);
}

function versionAtLeast(version, minimum) {
  const left = parseDottedVersion(version);
  const right = parseDottedVersion(minimum);
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const a = left[i] || 0;
    const b = right[i] || 0;
    if (a > b) {
      return true;
    }
    if (a < b) {
      return false;
    }
  }
  return true;
}

function otpMajorVersion(version) {
  return parseInt(version.split('.')[0], 10);
}

function parseMuslVersion(text) {
  if (!text) {
    return null;
  }
  const match = text.match(/Version\s+(\d+\.\d+(?:\.\d+)?)/i);
  return match ? match[1] : null;
}

function probeMuslVersion(lddOutput) {
  const fromLdd = parseMuslVersion(lddOutput);
  if (fromLdd) {
    return fromLdd;
  }

  const loaders = [
    '/lib/ld-musl-x86_64.so.1',
    '/lib/ld-musl-aarch64.so.1'
  ];
  for (const loader of loaders) {
    if (!fs.existsSync(loader)) {
      continue;
    }
    try {
      const out = execSync(`"${loader}" 2>&1 || true`).toString();
      const version = parseMuslVersion(out);
      if (version) {
        return version;
      }
    } catch (error) {
      const version = parseMuslVersion(`${error.stdout || ''}${error.stderr || ''}`);
      if (version) {
        return version;
      }
    }
  }
  return null;
}

function detectLinuxLibc() {
  // Only relevant on Linux. Note that the implementation is rather fragile
  // (the 'ldd' command is not consistent across all Linux distributions).
  if (os.platform() !== 'linux') {
    return { libc: null, muslVersion: null };
  }

  let lddOutput;
  try {
    lddOutput = execSync('ldd --version 2>&1 || true').toString();
  } catch (error) {
    throw new Error('Failed to determine the standard C library (glibc or musl)');
  }

  if (lddOutput.includes('glibc') || lddOutput.includes('GLIBC')) {
    return { libc: 'glibc', muslVersion: null };
  }

  return { libc: 'musl', muslVersion: probeMuslVersion(lddOutput) };
}

function muslTreeUnsupportedReason(otpVersion, muslVersion) {
  const major = otpMajorVersion(otpVersion);
  if (!(major >= OTP_SIGALTSTACK_MAJOR)) {
    return null;
  }
  if (!muslVersion) {
    return (
      'This runner uses musl, but the musl version could not be determined. ' +
      'Pre-built musl trees are for musl 1.2.5 (Alpine 3.21–3.23). ' +
      `OTP ${major} is not installed on an unknown musl version. ` +
      'Pin this job to alpine:3.23.'
    );
  }
  if (versionAtLeast(muslVersion, MUSL_UNSUPPORTED_FROM)) {
    return (
      'Pre-built musl Erlang/OTP trees are for musl 1.2.5 (Alpine 3.21–3.23). ' +
      `This runner has musl ${muslVersion}. ` +
      'OTP 26 and later abort on musl 1.2.6 with: ' +
      'sys_sigaltstack(): Failed to set alternate signal stack. ' +
      'Official OTP still uses a compile-time SIGSTKSZ (~8KiB). ' +
      'These trees are dynamically linked, so a 3.23 build is not safe here. ' +
      'Pin this job to alpine:3.23 (or 3.21/3.22). ' +
      'Alpine 3.24 and alpine:3 are unsupported until an official OTP release ' +
      'sizes the alternate signal stack at runtime.'
    );
  }
  return null;
}

function detectPlatform() {
  const linuxLibc = detectLinuxLibc();
  const platform = {
    os: getRunnerOS(),
    arch: getRunnerArchitecture(),
    libc: linuxLibc.libc,
    muslVersion: linuxLibc.muslVersion
  };
  return platform;
}

// Compute the platform name, which is used in the tarball name of the
// pre-built binaries.
function computePlatformName(platform) {
  let osName = platform.os;
  if (platform.os === 'linux') {
    if (platform.libc === 'musl') {
      osName = 'alpine';
    } else {
      osName = 'debian';
    }
  }
  const platformName = `${osName}-${platform.arch}`;
  return platformName;
}

// The name of the tarball (which contains the pre-built binaries) follows a
// specific format: erlang-otp-<version>-build-<os>-<arch>.tar.gz
function computeTarballName(version, platform) {
  const platformName = computePlatformName(platform);
  const tarballName = `erlang-otp-${version}-build-${platformName}.tar.gz`;
  return tarballName;
}

// The tarballs folder is where the pre-built binaries are stored in the S3
// bucket (for a given Erlang version).
function computeTarballsFolder(version) {
  const tarballFolder = `${S3_ENDPOINT_URL}/${S3_BUCKET_NAME}/${S3_PATH_PREFIX}/${version}`;
  return tarballFolder;
}

async function run() {
  try {
    // Read the Erlang/OTP version from the input. Use the latest version if
    // not specified.
    let erlangVersion = core.getInput('erlang-version');
    if (!erlangVersion) {
      console.log('No Erlang/OTP version specified, using the latest version.');
      erlangVersion = defaultVersion();
    }
    else {
      console.log(`Erlang/OTP version ${erlangVersion} is requested.`);
      erlangVersion = normalizeVersion(erlangVersion);
      console.log(`Selected Erlang/OTP version is ${erlangVersion}.`);
    }

    console.log(`Setting up Erlang/OTP version ${erlangVersion}.`);

    // Detect the platform where the action is running (so we understand what
    // pre-built binaries to install).
    const platform = detectPlatform();
    console.log(`Detected platform is ${JSON.stringify(platform)}.`);

    if (platform.libc === 'musl') {
      const muslReason = muslTreeUnsupportedReason(erlangVersion, platform.muslVersion);
      if (muslReason) {
        core.setOutput('unsupported-musl', 'true');
        throw new Error(muslReason);
      }
    }

    // Based on the platform, compute the location of the tarball to download
    // from the S3 bucket.
    const platformName = computePlatformName(platform);

    const tarballName = computeTarballName(erlangVersion, platform);
    const tarballsFolder = computeTarballsFolder(erlangVersion, platform);
    const tarballLocation = `${tarballsFolder}/${tarballName}`;
    console.log(`Computed pre-built binary URL is ${tarballLocation}`);

    // We download (if not already cached) the pre-built binaries and extract
    // into the installation directory.
    let toolPath = tc.find('erlang', erlangVersion, platformName);
    if (!toolPath) {
      // Try to download the tarball from the S3 bucket.
      let tarballDownloadPath;
      try {
        tarballDownloadPath = await tc.downloadTool(tarballLocation);
        console.log(`Downloaded Erlang/OTP to ${tarballDownloadPath}.`);
      } catch (error) {
        throw new Error(`Failed to download Erlang/OTP tarball: ${error.message}`);
      }

      const tempExtractedPath = await tc.extractTar(tarballDownloadPath);
      console.log(`Extracted Erlang/OTP to ${tempExtractedPath}.`);

      // Cache the final installation directory
      toolPath = await tc.cacheDir(tempExtractedPath, 'erlang', erlangVersion, platform.arch);
      console.log(`Cached Erlang/OTP to ${toolPath}`);

    } else {
      console.log(`Erlang/OTP found in cache at ${toolPath}`);
    }

    // Now we need to run the 'Install' script (so it generates the bin
    // directory with the Erlang/OTP executables). See Erlang OTP documentation
    // for more details.
    const erlangInstallDir = path.join(toolPath, `otp_build_${erlangVersion}`);
    const installScript = path.join(erlangInstallDir, 'Install');

    if (platform.os !== 'windows') {
      const args = ['-minimal', erlangInstallDir];
      await exec.exec(installScript, args, {cwd: erlangInstallDir});
    }
    else {
      // On Windows, there's no -minimal flag and it will prompt the user. This
      // is why we simulate pressing the "n" and Enter keys.
      const args = [erlangInstallDir];
      const options = {input: 'n\n', cwd: erlangInstallDir};
      await execFileSync(installScript, args, options);
    }

    // Add the Erlang installation path to the PATH environment variable.
    core.addPath(`${erlangInstallDir}/bin`);

    // Indicate the Erlang/OTP version that has actually been installed.
    core.setOutput('erlang-version', erlangVersion);

    // Indicate the location of the Erlang/OTP installation.
    core.setOutput('erlang-location', erlangInstallDir);

    // Install rebar3 script if requested.
    const installRebar3 = core.getBooleanInput('install-rebar3', {required: false});
    if (installRebar3 === true) {
      console.log('Installing rebar3 script...');

      // Download the rebar3 script (temporary location).
      let tmpRebar3Script = await tc.downloadTool(REBAR3_DOWNLOAD_URL);

      // Create an installation directory for the rebar3 script(s).
      const rebar3InstallDir = path.join(toolPath, `rebar`);
      fs.mkdirSync(rebar3InstallDir);

      // Move the rebar3 script to the installation directory.
      const rebar3Script = path.join(rebar3InstallDir, 'rebar3');
      fs.copyFileSync(tmpRebar3Script, rebar3Script);
      fs.unlinkSync(tmpRebar3Script);

      // Make the rebar3 script executable.
      if (platform.os !== 'windows') {
        fs.chmodSync(rebar3Script, '755');
      }

      // On Windows, an additional rebar3.cmd script must be placed alongside.
      if (platform.os === 'windows') {
        const rebar3CmdScriptText = `
@echo off
setlocal
set rebarscript=%~f0
escript.exe "%rebarscript:.cmd=%" %*
        `;
        const rebar3CmdScript = path.join(rebar3InstallDir, 'rebar3.cmd');
        fs.writeFileSync(rebar3CmdScript, rebar3CmdScriptText.trim());
      }

      core.addPath(rebar3InstallDir);
      console.log('The rebar3 script is installed.');
    }
    else {
      console.log('Installation of rebar3 script not requested.');
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
