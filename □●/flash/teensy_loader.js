
/* ** teensy_loader.js **
 *
 * Copyright (C)2022 - Eduard Heidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

import MemoryMap from "./intel-hex.js" //https://github.com/NordicSemiconductor/nrf-intel-hex
import { } from "./jszip.js"

let firmwareUrl = 'https://ehx.spdns.org/squares-and-circles/flash/index.json'

let artifacts = await fetch(firmwareUrl + "?" + new Date().toString());
artifacts = await artifacts.json();

console.log(artifacts)

var select = document.getElementById("firmwares");

Object.keys(artifacts).forEach(key => {
    var el = document.createElement("option");
    el.textContent = artifacts[key];
    el.value = artifacts[key];
    select.appendChild(el);
});

async function latestFirmwareHex() {

    console.log(select.value)

    let artifact = await fetch("https://ehx.spdns.org/squares-and-circles/flash/" + select.value + ".zip")

    let zipBlob = await artifact.blob()
    let zip = await JSZip.loadAsync(zipBlob);
    let fileName = Object.keys(zip.files).filter(name => name.startsWith("firmware"));
    var hex = await zip.file(fileName[0]).async("string")

    return hex;
}

let flashButton = document.getElementById('flashButton')
flashButton.onclick = loadFirmware
let resetButton = document.getElementById('resetButton')
resetButton.onclick = teensyReset

function progres(value, max) {
    let element = document.getElementById('progress')
    element.value = value;
    element.max = max;
}

function log(msg) {
    let logDiv = document.getElementById('log')
    logDiv.innerHTML += msg + "<br/>";
    fetch(firmwareUrl + "?log=" + encodeURIComponent(msg))
}

function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

async function loadFirmware() {

    let filters = [{ vendorId: 0x16C0, productId: 0x0478 }];
    let devices = await navigator.hid.requestDevice({ filters });

    let device = devices[0];

    if (device == null)
        return

    try {
        flashButton.disabled = resetButton.disabled = true

        await device.open();

        log("Flashing firmware " + select.value + ", please wait..")

        if (0) {
            let r = await fetch('https://raw.githubusercontent.com/PaulStoffregen/teensy_loader_cli/master/blink_slow_Teensy40.hex')
            var hex = await r.text();
        }
        else {

            var hex = await latestFirmwareHex();
            // let r = await fetch('firmware-a24c2.zip')
            // let zip = await JSZip.loadAsync(await r.blob());
            // var hex = await zip.file("firmware_a24c2ce.hex").async("string")
        }

        let memMap = MemoryMap.fromHex(hex);
        let flashData = memMap.get(0x60000000);

        //https://github.com/PaulStoffregen/teensy_loader_cli/blob/master/teensy_loader_cli.c
        //https://www.pjrc.com/teensy/halfkay_protocol.html

        let block_size = 1024;
        for (let addr = 0; addr < flashData.length; addr += block_size) {

            progres(addr, flashData.length)

            let is_blank = true;

            for (let i = 0; i < block_size && is_blank; i++) {
                if (flashData[addr + i] != 255)
                    is_blank = false;
            }

            if (is_blank) {
                console.log("page 0x" + addr.toString(16) + " blank");
                continue;
            }

            let cmd = new Uint8Array(64);
            cmd.fill(0);
            cmd[0] = (addr >> 0) & 0xFF;
            cmd[1] = (addr >> 8) & 0xFF;
            cmd[2] = (addr >> 16) & 0xFF;

            let writeBlock

            if (addr + block_size > flashData.length) {
                let data = flashData.slice(addr);
                let pad = new Uint8Array(block_size - data.length);
                pad.fill(0xFF);
                writeBlock = Uint8Array.from([...cmd, ...data, ...pad]);
                console.log("last page");
            } else {
                let data = flashData.slice(addr, addr + block_size);
                writeBlock = Uint8Array.from([...cmd, ...data]);
                console.log("page 0x" + addr.toString(16));
            }

            await device.sendReport(0, writeBlock);

            if (addr == 0)
                await delay(3000);
            else
                await delay(100);
        }

        progres(100, 100)

        //reboot
        let cmd = new Uint8Array(64 + block_size);
        cmd.fill(0);
        cmd[0] = 0xFF;
        cmd[1] = 0xFF;
        cmd[2] = 0xFF;
        await device.sendReport(0, cmd);
        log("..finished! - have fun!");
    }
    catch (e) {
        log(e + "- please try again.")
    }
    finally {
        if (device)
            await device.close();

        flashButton.disabled = resetButton.disabled = false
    }
}

async function teensyFetchSerial() {

    //https://www.pjrc.com/teensy/rawhid.html

    let rawHidFilter = { vendorId: 0x16C0, productId: 0x0478, usagePage: 0xFFAB, usage: 0x0200 };
    let serEmuFilter = { vendorId: 0x16C0, productId: 0x0485, usagePage: 0xFFC9, usage: 0x0004 }; // SerEMU interface
    let rawHidParams = { filters: [serEmuFilter] };
    let devices = await navigator.hid.requestDevice(rawHidParams); //get allowance to connect to a rawHID Teensy
    if (devices === null || devices.length == 0) return;

    var device = devices[0];

    await device.open()

    function handleInputRedevice(e) {
        var enc = new TextDecoder("utf-8");
        log(enc.decode(e.data))
    };

    device.addEventListener('inputreport', handleInputRedevice);
}

async function teensyReset() {

    let filters = [{ usbVendorId: 0x16C0 }];
    let port = await navigator.serial.requestPort({ filters });

    try {

        //https://github.com/PaulStoffregen/teensy_loader_cli/blob/master/teensy_loader_cli.c "soft_reboot"
        await port.open({ baudRate: 0x86 });
        await delay(200);


    }
    catch (e) {
        log(e)
    }
    finally {
        log("..reset!");
        if (port)
            await port.close();
    }

    // let serEmuFilter = { vendorId: 0x16C0 /*, productId: 0x0485, usagePage: 0xFFC9, usage: 0x0004*/ }; // SerEMU interface
    // let rawHidParams = { filters: [serEmuFilter] };
    // let devices = await navigator.hid.requestDevice(rawHidParams); //get allowance to connect to a rawHID Teensy
    // if (devices === null || devices.length == 0) return;

    // var device = devices[0];

    // await device.open()

    // function handleInputRedevice(e) {
    //     var enc = new TextDecoder("utf-8");
    //     log(enc.decode(e.data))
    // };

    // device.addEventListener('inputreport', handleInputRedevice);
}


window.loadFirmware = loadFirmware;
window.teensyFetchSerial = teensyFetchSerial;
window.teensyReset = teensyReset;