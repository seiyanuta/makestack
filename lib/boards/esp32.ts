import { spawn, spawnSync } from "child_process";
import * as os from "os";
import * as path from "path";
import { resolveRepoPath, exec } from "../helpers";
import * as fs from "fs";
import { BuildError } from ".";
import { logger } from "../logger";
import { Spinner } from "../spinner";
import * as assert from "assert";

export function getFirmwarePath(): string {
    return resolveRepoPath("firmware/build/esp32/firmware.bin");
}
export async function flashFirmware(devicePath: string, firmwarePath: string) {
    // TODO: Use firmwarePath!
    assert.equal(
        firmwarePath,
        resolveRepoPath("firmware/build/esp32/firmware.bin")
    );

    exec(["/usr/bin/make", "BOARD=esp32", "ESPPORT=" + devicePath, "flash"], {
        cwd: resolveRepoPath("firmware"),
    });
}

export async function buildFirmware(appDir: string, appCxx: string) {
    const buildLogPath = path.join(appDir, "build.log");
    const firmwareDir = resolveRepoPath("firmware");
    const buildDir = path.join(firmwareDir, "build/esp32");
    const componentDir = path.join(buildDir, "makestack-app");

    await installDependencies(firmwareDir);

    // Create an ESP-IDF component.
    const componentMk = "CXXFLAGS += -fdiagnostics-color=always";
    fs.mkdirSync(componentDir, { recursive: true });
    fs.writeFileSync(path.join(componentDir, "component.mk"), componentMk);
    fs.writeFileSync(path.join(componentDir, "app.cpp"), appCxx);

    await make(firmwareDir, componentDir, buildLogPath);
}

const TOOLCHAIN_VERSION = "1.22.0-80-g6c4433a-5.2.0";
const GIT_REPOS = [
    {
        name: "esp-idf",
        url: "https://github.com/espressif/esp-idf",
        rev: "055943e29346e77c50589c61a8a26101a8b35d7b",
    },
    {
        name: "arduino-esp32",
        url: "https://github.com/espressif/arduino-esp32",
        rev: "7d7824701fe5e22f08555d3e1ce3180a922b2151",
    },
];

async function installDependencies(firmwareDir: string) {
    const depDir = path.join(firmwareDir, "deps/esp32");
    if (fs.existsSync(depDir)) {
        // They have been already installed.
        return;
    }

    logger.progress("Downloading dependencies...");
    const tmpDir = path.resolve(os.tmpdir(), "makestack-esp32-deps");
    fs.mkdirSync(tmpDir);

    // Download and extract the ESP32 toolchain.
    let osName;
    switch (os.type()) {
        case "Linux":
            osName = "linux64";
            break;
        case "Darwin":
            osName = "osx";
            break;
        default:
            throw new Error("Unsupported os type");
    }
    const toolchainBaseName = `xtensa-esp32-elf-${osName}-${TOOLCHAIN_VERSION}.tar.gz`;
    const toolchainUrl = `https://dl.espressif.com/dl/${toolchainBaseName}`;
    const toolchainTarball = path.join(tmpDir, toolchainBaseName);
    exec(["curl", "-fSL", "--output", toolchainTarball, toolchainUrl]);
    exec(["tar", "xf", toolchainTarball, "-C", tmpDir]);

    // Clone Git repositories.
    for (const { name, url, rev } of GIT_REPOS) {
        // TODO: make this async
        const repoDir = path.join(tmpDir, name);
        exec(["git", "clone", "--recursive", url, repoDir]);
        exec(["git", "checkout", rev], { cwd: repoDir });
        exec(["git", "submodule", "update", "--init", "--recursive"], {
            cwd: repoDir,
        });
    }

    // Install pip dependencies.
    const requirementsPath = path.join(tmpDir, "esp-idf/requirements.txt");
    exec(["pip", "install", "--user", "-r", requirementsPath]);

    fs.renameSync(tmpDir, depDir);
    logger.success("Successfully downloaded dependencies");
}

function make(firmwareDir: string, componentDir: string, buildLogPath: string) {
    return new Promise((resolve, reject) => {
        const makePath = "/usr/bin/make";
        const procs = os.cpus().length;
        const cp = spawn(makePath, [`-j${procs}`, "build"], {
            cwd: firmwareDir,
            stdio: "pipe",
            env: Object.assign({}, process.env, {
                BOARD: "esp32",
                PATH: process.env.PATH,
                MY_COMPONENT_DIRS: componentDir,
                MAKESTACK_APP: "1",
            }),
        });

        let stdout = "";
        let spinner = new Spinner();
        spinner.start();
        cp.stdout.on("data", (data: Buffer) => {
            const str = data.toString("utf-8");
            stdout += str;
            for (const line of str.trim().split("\n")) {
                spinner.update(line);
            }
        });

        let stderr = "";
        cp.stderr.on("data", (data: Buffer) => {
            const str = data.toString("utf-8");
            stderr += str;
        });

        cp.on("exit", (status: number) => {
            spinner.reset();
            fs.writeFileSync(
                buildLogPath,
                `stdout:\n${stdout}\n\nstderr:\n${stderr}`
            );

            if (status == 0) {
                resolve();
            } else {
                console.error(stderr);
                reject(new BuildError());
            }
        });
    });
}
