#!/usr/bin/env node
/*jslint node: true */
"use strict";

// ============================================================================

/**
 * @typedef {function} Predicate
 * @param {String} fn the file name
 * @returns {boolean} true if file should be deleted for this environment, false otherwise.
 */

/**
 * @typedef {Object} EnvDef
 * @property {string} environment verbose name
 * @property {string} option command line option name
 * @property {Predicate} deleteFilePredicate
 */

/**
 * @typedef {Object} CmdLineDef
 * @prop {string} name the name of the command line option including double dash (--)
 * @prop {string} verbose documentation text for command line option.
 * @prop {function} handler function executed if option is set on command line
 */

/**
* @typedef {Object} Options
* @prop {EnvDef} environment
* @prop {boolean} dryRun
*/

// ============================================================================

const path = require('path');
const fs = require("fs");
const os = require("os");
const debug = require('debug')('dynatrace');

const cStateNotTailored = "untailored";
const cStateUndefined = "undefined";
const cStateLambdaWithNode4 = "AWS Lambda with Node 4.x";
const cStateLambdaWithNode6 = "AWS Lambda with Node 6.x";
const cStates = [
	cStateNotTailored,
	cStateUndefined,
	cStateLambdaWithNode4,
	cStateLambdaWithNode6
];

const cStateFileName = path.join(__dirname, "pkgtailor-state");

/**
 * compatibility to Node versions <6.3.0 (fs.F_OK etc. deprecated)
 */
const cFsConstants = (fs.constants || fs);

/** 
 * delete all files in folder 'lib' and 'linux-x86-32'
 */
const c32BitPathPattern = /((\/lib)|(\/linux-x86-32))\/[^\/]+$/;

/** 
 * Environment definition for AWS Lambda V4
 * @const {EnvDev} 
 */
const cLambdaV4EnvDef = {
	name: cStateLambdaWithNode4,
	deleteFilePredicate: (fn) => {
		// preserve all *_46.node files except 32 bit binaries
		return /_(4[^6]|[^4][0-9])\.node$/.test(fn) || c32BitPathPattern.test(fn);
	}
};

/** 
 * Environment definition for AWS Lambda V6
 * @const {EnvDev} 
 */
const cLambdaV6EnvDef = {
	name: cStateLambdaWithNode6,
	deleteFilePredicate: (fn) => {
		// preserve all *_48.node files except 32 bit binaries
		return /_(4[^8]|[^4][0-9])\.node$/.test(fn) || c32BitPathPattern.test(fn);
	}
};

/**
 * @const {CmdLineDef[]}
 */
const cCmdLineOptionsDef = [
	{
		name: "--help",
		verbose: "Print this help",
		handler: () => printHelpAndExit(0)
	},
	{
		name: "--dryRun",
		verbose: "Print files which to be deleted and exit.",
		handler: () => options.dryRun = true
	},
	{
		name: "--state",
		verbose: "Print current tailoring state of npm module and exit.",
		handler: () => printTailoringStatusAndExit()
	},
	{
		name: "--AwsLambdaV4",
		verbose: "Tailor environment for AWS Lambda with Node.js V4.x",
		handler: () => {
			debug("setting environment to AWS cLambdaV4EnvDef");
			options.environment = cLambdaV4EnvDef;
		}
	},
	{
		name: "--AwsLambdaV6",
		verbose: "Tailor environment for AWS Lambda with Node.js V6.x",
		handler: () => {
			debug("setting environment to AWS cLambdaV6EnvDef");
			options.environment = cLambdaV6EnvDef;
		}
	}
];

/** 
  * receives comand line option values
  * @const {Options} 
  */
const options = {
	environment: undefined,
	dryRun: false
};

// ============================================================================

/**
 * attempts to read the state file from previous tailoring run
 * @returns {string} tailoring state
 */
function tryReadStateFile() {
	let state = cStateUndefined;

	try {
		fs.accessSync(cStateFileName, cFsConstants.F_OK | cFsConstants.R_OK | cFsConstants.W_OK);
		try {
			state = fs.readFileSync(cStateFileName, "utf-8");
			debug(`read state '${state}' from ${cStateFileName}`);
		} catch (e) {
			throw new Error(`failed to read tailoring state from ${cStateFileName}`);
		}
	} catch (e) {
		throw new Error(`state file ${cStateFileName} is not accessable`);
	}
	return state;
}

/**
 * write tailoring state to state file
 * @param {string} state 
 */
function writeStateFile(state) {
	fs.writeFileSync(cStateFileName, state);
}

/**
 * scan given folder recursively and return list of files 
 * @param {string} folderName folder to recursively scan for files
 * @returns {string[]} files found in folder
 */
function scanFolder(folderName) {
	const entries = fs.readdirSync(folderName).map((e) => path.join(folderName, e));

	/** @type {string[]} */
	let files = [];
	entries.forEach((e) => {
		const stat = fs.statSync(e);
		if (stat.isDirectory()) {
			scanFolder(e).forEach(f => files.push(f));
		} else if (stat.isFile()) {
			files.push(e);
		}
	});

	if (os.platform() === "win32") {
		// normalize win32 paths (lower case, replace back slash with forward slash)
		files = files.map(f => f.replace(/\\/g, "/").toLowerCase());
	}
	return files;
}

/**
 * locate the dependency package agent folder
 * will throw error if pacakge cannot be located
 * @returns {string} the absolute path to the folder location
 */
function locateDependencyModule() {
	const innerPath = path.join("oneagent-dependency", "agent");
	const dependencyLocations = [
		path.join(__dirname, "..", "node_modules", "@dynatrace", innerPath),
		path.join(__dirname, "..", "..", innerPath)
	];

	let location;
	dependencyLocations.some(p => {
		try {
			debug(`testing dependency module location '${p}'`);

			fs.accessSync(p, cFsConstants.F_OK);
			location = p;
			return true;
		} catch (e) {
			return false;
		}
	});

	debug(`locateDependencyModule: ${location}`);
	if (!location) {
		// cannot recover from here
		throw new Error("Could not locate 'oneagent-dependency' module");
	}
	return location;
}

/** 
 * execute the tailoring and dry run
 */
function tailorModule() {
	if (!options.environment) {
		throw new Error("no environment for tailoring specified.");
	}

	// locate dependency module and get all files in module folder
	const dependencyLocation = locateDependencyModule();
	const allFiles = scanFolder(dependencyLocation);
	debug(`files found: ${allFiles.join("\n  ")}`);

	// identify files to be deleted
	const filesToDelete = allFiles.filter(fn => options.environment.deleteFilePredicate(fn));

	console.log(`\nTailoring npm module for environment '${options.environment.name}'`);

	if (options.dryRun) {
		console.log("Dry run - following files will be deleted from npm module");
		filesToDelete.forEach((fn) => {
			// check file access rights
			fs.accessSync(fn, fs.F_OK | fs.R_OK | fs.W_OK);
			console.log(`  ${fn}`);
		});
		console.log();
	}
	else {
		// set undefined state
		writeStateFile(cStateUndefined);
		filesToDelete.forEach((fn) => {
			console.log(`  deleting file '${fn}'`);
			fs.unlinkSync(fn);
		});
		writeStateFile(options.environment.name);
	}
}

/**
 * print the persisted tailoring status and exit
 */
function printTailoringStatusAndExit() {
	let msg;
	if (persistedTailoringState === cStateNotTailored) {
		msg = "The npm module has not been tailored for a specific runtime environment.";
	} else {
		msg = `The npm module has been tailored for runtime environment: ${persistedTailoringState}`;
	}
	console.log(`TAILORING STATE: ${msg}`);
	process.exit(0);
}

/**
 * print help and execute process exit
 * @param {number} exitCode the optional exit code (defaults to 1)
 * @returns will never return
 */
function printHelpAndExit(exitCode) {
	if (!exitCode) {
		exitCode = 1;
	}

	console.log();
	const msg = "Usage: dt-oneagent-tailor [options]\n\n" +
		"The  @dynatrace/oneagent npm  module (to be precise, its  dependent module\n" +
		"@dynatrace/oneagent-dependency)  incorporates binary files for all Node.js\n" +
		"Node.js versions supported by Dynatrace.  As specific runtime environments\n" +
		"(e.g. AWS Lambda) do  support very  specific Node.js versions only, binary\n" +
		"files of unsupported Node.js versions can be  deleted from the npm module.\n" +
		"This will  reduce the deployment  package file size significantly (e.g. to\n" +
		"overcome the 10MB upload restriction of AWS Lambda)\n\n" +
		"This  script tailors npm  module content for  a selected  specific runtime\n" +
		"environments.\n\n" +
		"valid options are:";

	console.log(msg);
	cCmdLineOptionsDef.forEach(def => {
		let spacer = new Array(30 - def.name.length).fill(".");
		console.log(`  ${def.name} ${spacer.join("")} ${def.verbose}`);
	});

	console.log();
	process.exit(exitCode);
}
/**
 * lookup given option in cCmdLineOptionsDef
 * @param  option {string} the command line option to lookup
 * @returns {CmdLineDef|undefined} definition of the command line option. undefined, if unknown option
 */
function lookupOption(option) {
	return cCmdLineOptionsDef.find((def) => (def.name === option));
}

/**
 * parse command line options
 */
function parseOptions() {
	if (process.argv.length < 3) {
		process.argv.push("--help");
	}

	// start beyond exe and script name
	for (let i = 2; i < process.argv.length; ++i) {
		const option = process.argv[i];
		debug(`processing command line option '${option}'`);
		const def = lookupOption(option);
		if (!def) {
			console.log(`unknown command line option '${option}'`);
			printHelpAndExit();
		} else {
			debug(`executing handler for '${def.name}'`);
			def.handler();
		}
	}
}

/**
 * prints the tailoring result
 * @param {Error|undefined} e 
 */
function printResult(e) {
	if (e) {
		console.log(`Error encountered: '${e.message}'`);
	}
	
	let env = "";
	if (options.environment) {
		env = ` for environment '${options.environment.name}'`;
	}
	console.log(`\n${(options.dryRun ? "[DRY RUN] " : "")}Tailoring npm module${env}: ${!e ? "SUCCEEDED" : "FAILED"}`);
}

/** 
 * the tailoring state read from state file
 * @type {string} 
 */
let persistedTailoringState;

try {
	//console.log("Tailor @dynatrace/oneagent npm module for specific runtime environments.\n");

	persistedTailoringState = tryReadStateFile();
	parseOptions();

	if (cStates.indexOf(persistedTailoringState) < 0) {
		console.log(`ERROR: npm module is in an unknown tailoring state '${persistedTailoringState}'`);
	} else if (persistedTailoringState === cStateUndefined) {
		console.log("ERROR: Previous tailoring state left npm module in an undefined state. Please re-install npm module.");
	} else if (persistedTailoringState !== cStateNotTailored) {
		if (persistedTailoringState === options.environment.name) {
			console.log(`The npm module has been already tailored for environment '${persistedTailoringState}'`);
		} else {
			console.log(`ERROR: The npm module has been already tailored for environment '${persistedTailoringState}`);
			console.log(`Please uninstall and re-install @dynatrace/oneagent module to tailor for environment '${options.environment.name}'`);
		}
	} else {
		tailorModule();
		printResult();
	}
} catch (e) {
	debug("cought exception", e);
	printResult(e);
}