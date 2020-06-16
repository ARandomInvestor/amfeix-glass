'use strict';

import Config from "./config.js"

import {CacheProvider, StorageContract, FullNodeBitcoinProvider, BlockchainComBitcoinProvider, InvestorAccount, BitcoinUnitConverter} from "amfeix-api";

console.log()

import Web3 from "web3"
import Web3HttpProvider from "web3-providers-http"
import Client from "bitcoin-core";
import process from "process"
import bitcoin from "bitcoinjs-lib";
import fs from "fs"
import path from "path";
import BigNumber from "bignumber.js";

import async from "async"


let cache = new CacheProvider("./");

function getAccountFile(k){
    try{
        let result = fs.readFileSync("./", path.resolve("index", "accounts", k[2].toLowerCase(), k + ".json"))
        return JSON.parse(result);
    }catch (e) {
        return null;
    }
}

function setAccountFile(k, v){
    fs.writeFile(path.resolve("./", "index", "accounts", k[2].toLowerCase(), k + ".json"), JSON.stringify(v, null, " "), () => {});
}

let provider = new Web3HttpProvider(Config.ethereum.url, {
    keepAlive: true,
    timeout: 20000
})

let web3 = new Web3(provider);

let btc = null;
if(Config.bitcoin.provider.toLowerCase() === "fullnode"){
    let client = new Client({
        host: Config.bitcoin.bitcoind.host,
        port: Config.bitcoin.bitcoind.port,
        ssl: {
            enabled: Config.bitcoin.bitcoind.ssl,
            strict: false
        },
        agentOptions: {

        },
        username: "bitcoin",
        password: "bitcoin",
        network: "mainnet"
    });

    btc = new FullNodeBitcoinProvider(cache, client, {
        host: Config.bitcoin.electrum.host,
        port: Config.bitcoin.electrum.port,
        ssl: Config.bitcoin.electrum.ssl
    });
}else if (Config.bitcoin.provider.toLowerCase() === "blockchain.com"){
    btc = new BlockchainComBitcoinProvider(cache);
}else{
    throw new Error("Unknown config bitcoin.provider " + Config.bitcoin.provider);
}

let contract = new StorageContract(web3, cache, btc);

let totalDeposit = new BigNumber(0);
let totalWithdrawn = new BigNumber(0);
let totalWithdrawnReferrers = new BigNumber(0);

let totalCurrentBalance = new BigNumber(0);
let totalCurrentReferrers = new BigNumber(0);

let pendingWithdrawals = [];
let allWithdrawals = [];

let bitcoinMapping = {};
let ethereumMapping = {};
let knownSystemAddresses = {};


function pad(n){return n<10 ? '0'+n : n}

contract.getInvestors().then(async (investors) => {

    let fundAddresses = await contract.getDepositAddresses();
    for(let i in fundAddresses){
        knownSystemAddresses[fundAddresses[i]] = 1;
    }

    let processed = [];
    let startTime = new Date();

    let maxInProcess = 16;
    let totalLength = investors.length;

    let queue = async.queue(async (task) => {
        try {
            let account = await InvestorAccount.fromEthereumAddress(task, contract);
            if (bitcoinMapping.hasOwnProperty(account.getBitcoinAddress())) {
                totalLength--;
                return;
            }

            //console.log("Starting " + task.toLowerCase())

            bitcoinMapping[account.getBitcoinAddress()] = account.getPublicKey();
            ethereumMapping[account.getEthereumAddress().toLowerCase()] = account.getPublicKey();
            let data = await account.getBalance();

            let oldAccount = getAccountFile(account.getPublicKey());
            let needsFullUpdate = oldAccount === null;

            if(!needsFullUpdate){
                if(Object.keys(oldAccount.transactions).length !== Object.keys(data.transactions).length){
                    needsFullUpdate = true;
                }else{
                    for(let txid in oldAccount.transactions){
                        let oldTx = oldAccount.transactions[txid];
                        let newTx = data.transactions[txid];
                        if(!oldTx.hasOwnProperty("related") || oldTx.exit_timestamp !== newTx.exit_timestamp){
                            needsFullUpdate = true;
                        }else if(oldTx.hasOwnProperty("related")){
                            for(let j in oldTx.related){
                                let r = oldTx.related[j];
                                if(r.track_type === "withdrawal"){
                                    for (let x in r.ins) {
                                        if(btc.getAddressForInput(r.ins[x]) === account.getBitcoinAddress()){
                                            needsFullUpdate = true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            let addToSystemAddresses = (related) => {
                for(let j in related){
                    let r = related[j];
                    if(r.track_type === "withdrawal"){
                        for (let x in r.ins) {
                            let addr = btc.getAddressForInput(r.ins[x]);
                            if(addr !== account.getBitcoinAddress()){
                                if(!(addr in knownSystemAddresses)){
                                    knownSystemAddresses[addr] = 0;
                                }

                                knownSystemAddresses[addr]++;
                            }
                        }
                    }
                }
            }

            if(needsFullUpdate){
                let matchingTransactions = await account.getBitcoinMatchingTransactions(data);
                let getRelatedTx = (txid) => {
                    let related = [];
                    for(let j in matchingTransactions){
                        if(matchingTransactions[j].track_txid.includes(txid)){
                            related.push(matchingTransactions[j]);
                        }
                    }

                    return related;
                };
                for (let txid in data.transactions) {
                    let tx = data.transactions[txid];
                    tx.related = getRelatedTx(tx.txid);
                    addToSystemAddresses(tx.related)
                }
            }else{
                for (let txid in data.transactions) {
                    let tx = data.transactions[txid];
                    tx.related = oldAccount.transactions[txid].related;
                    addToSystemAddresses(tx.related)
                }
            }

            for (let txid in data.transactions) {
                let tx = data.transactions[txid];
                if (tx.exit_timestamp === null && tx.hasOwnProperty("requested_exit")) {
                    pendingWithdrawals.push(tx);
                }

                if (tx.hasOwnProperty("requested_exit")) {
                    allWithdrawals.push(tx)
                }

                if (tx.exit_timestamp === null) {
                    if (tx.signature === "referer") {
                        totalCurrentReferrers = totalCurrentReferrers.plus(tx.balance);
                    } else {
                        totalCurrentBalance = totalCurrentBalance.plus(tx.balance);
                    }
                } else {
                    if (tx.signature === "referer") {
                        totalWithdrawnReferrers = totalWithdrawnReferrers.plus(tx.balance);
                    } else {
                        totalWithdrawn = totalWithdrawn.plus(tx.balance);
                    }
                }

                totalDeposit = totalDeposit.plus(tx.value);
            }

            if (totalDeposit.isNaN()) {
                console.log("NaN deposit", data);
                process.exit(1)
                return;
            }

            setAccountFile(account.getPublicKey(), data);

            processed.push(account.getEthereumAddress());

            console.log("Processed " + task.toLowerCase() + " [" + (processed.length) + "/" + totalLength + "]")
        } catch (e) {
            console.log(e)
        }

    }, maxInProcess);

    for(let i in investors){
        queue.push(investors[i]);
    }

    await queue.drain();


    console.log("Total deposited: " + BitcoinUnitConverter.from_Satoshi(totalDeposit).to_BTC().toFormat(BitcoinUnitConverter.getDecimalPlaces()));
    console.log("Total withdrawn (deposits): " + BitcoinUnitConverter.from_Satoshi(totalWithdrawn).to_BTC().toFormat(BitcoinUnitConverter.getDecimalPlaces()));
    console.log("Total withdrawn (referrals): " + BitcoinUnitConverter.from_Satoshi(totalWithdrawnReferrers).to_BTC().toFormat(BitcoinUnitConverter.getDecimalPlaces()));
    console.log("Total balance (deposits): " + BitcoinUnitConverter.from_Satoshi(totalCurrentBalance).to_BTC().toFormat(BitcoinUnitConverter.getDecimalPlaces()));
    console.log("Total balance (referrals): " + BitcoinUnitConverter.from_Satoshi(totalCurrentReferrers).to_BTC().toFormat(BitcoinUnitConverter.getDecimalPlaces()));
    //ALL DONE


    allWithdrawals.sort((a, b) => {
        return b.requested_exit - a.requested_exit;
    })
    pendingWithdrawals.sort((a, b) => {
        return b.requested_exit - a.requested_exit;
    })

    console.log();
    console.log();

    let formatDate = (date) => {
        return date.getUTCFullYear() + "/" + pad(date.getUTCMonth() + 1) + "/" + pad(date.getUTCDate()) + " " + pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes()) + ":" + pad(date.getUTCSeconds());
    }

    if (allWithdrawals.length > 0) {
        let withdrawEntries = [];
        let pendingEntries = [];
        let processedEntries = [];

        let csv = "";
        let wCsv = "";

        csv += ("request date, btc address, eth address, transaction, value, paid out date, paid out transaction, delay (as of " + formatDate(startTime) + ")\r\n");

        for (let i in allWithdrawals) {
            let tx = allWithdrawals[i];
            let account = new InvestorAccount(tx.pubkey);
            let date = (new Date(tx.requested_exit * 1000));
            let paidOut = "PENDING";
            let relatedTx = "";
            let delay = startTime - date;
            if (tx.exit_timestamp !== null) {
                paidOut = (new Date(tx.exit_timestamp * 1000));
                delay = paidOut - date;
                paidOut = formatDate(paidOut);
                if(tx.related !== null && tx.related.length > 0){
                    for(let j in tx.related){
                        if(tx.related[j].track_type === "withdrawal"){

                            relatedTx = tx.related[j].txid;
                            break;
                        }
                    }
                }

                if(relatedTx === ""){
                    relatedTx = "not matched";
                }
            }
            delay = Math.ceil((delay / 1000) / 3600);
            delay = Math.floor(delay / 24) + " day(s) " + pad(delay % 24) + " hours";
            let balance = BitcoinUnitConverter.from_Satoshi(tx.balance).to_BTC().toFormat(BitcoinUnitConverter.getDecimalPlaces());
            let entry = {
                rd: formatDate(date),
                btc: account.getBitcoinAddress(),
                eth: account.getEthereumAddress().toLowerCase(),
                tx: account.getBitcoinAddress() in knownSystemAddresses ? "SYSTEM TX" : (tx.signature === "referer" ? "REFERRER" : tx.txid),
                v: balance,
                pd: paidOut,
                ptx: relatedTx,
                d: delay
            }

            withdrawEntries.push(entry);

            if (tx.exit_timestamp !== null) {
                let entry2 = Object.assign({}, entry);
                entry2.exit_timestamp = tx.exit_timestamp;
                processedEntries.push(entry2);
            } else {
                pendingEntries.push(entry);
                wCsv += (account.getBitcoinAddress() + ", " + balance + "\r\n");
            }

            csv += (formatDate(date) + ", " + account.getBitcoinAddress() + ", " + account.getEthereumAddress().toLowerCase() + ", " + (tx.signature === "referer" ? "REFERRER" : tx.txid) + ", " + balance + ", " + paidOut + ", " + relatedTx + ", " + delay + "\r\n");
        }

        processedEntries.sort((a, b) => {
            return b.exit_timestamp - a.exit_timestamp;
        })

        for (let i in processedEntries) {
            delete processedEntries[i].exit_timestamp;
        }

        const knownSystemAddressesOrdered = {};
        Object.keys(knownSystemAddresses).sort((a, b) => {
            return b - a;
        }).forEach(function(key) {
            knownSystemAddressesOrdered[key] = knownSystemAddresses[key];
        });


        fs.writeFile(path.resolve("web", "withdrawEntries.json"), JSON.stringify(withdrawEntries), () => {
        });
        fs.writeFile(path.resolve("web", "pendingEntries.json"), JSON.stringify(pendingEntries), () => {
        });
        fs.writeFile(path.resolve("web", "processedEntries.json"), JSON.stringify(processedEntries), () => {
        });
        fs.writeFile(path.resolve("web", "latest.csv"), csv, () => {
        });
        fs.writeFile(path.resolve("web", "many.txt"), wCsv, () => {
        });


        fs.writeFile(path.resolve("index", "bitcoinMapping.json"), JSON.stringify(bitcoinMapping, null, " "), () => {
        });
        fs.writeFile(path.resolve("index", "ethereumMapping.json"), JSON.stringify(ethereumMapping, null, " "), () => {
        });
        fs.writeFile(path.resolve("index", "pendingWithdrawals.json"), JSON.stringify(pendingWithdrawals, null, " "), () => {
        });
        fs.writeFile(path.resolve("index", "knownSystemAddresses.json"), JSON.stringify(knownSystemAddressesOrdered, null, " "), () => {
        });
    }

});