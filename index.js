'use strict';

import Config from "./config.js"
import StorageContract from "./src/amfeix/StorageContract.js"
import BitcoinProvider from "./src/amfeix/bitcoin/BitcoinProvider.js"
import Web3 from "web3"
import Web3HttpProvider from "web3-providers-http"
import Client from "bitcoin-core";
import InvestorAccount from "./src/amfeix/InvestorAccount.js";
import process from "process"
import bitcoin from "bitcoinjs-lib";
import fs from "fs"
import path from "path";


function getAccountFile(k){
    try{
        let result = fs.readFileSync(path.resolve("index", "accounts", k[2].toLowerCase(), k + ".json"))
        return JSON.parse(result);
    }catch (e) {
        return null;
    }
}

function setAccountFile(k, v){
    fs.writeFile(path.resolve("index", "accounts", k[2].toLowerCase(), k + ".json"), JSON.stringify(v, null, " "), () => {});
}

let provider = new Web3HttpProvider(Config.ethereum.url, {
    keepAlive: true,
    timeout: 20000
})

let web3 = new Web3(provider);
let infuraWeb = new Web3(Config.ethereum.infuraUrl ? Config.ethereum.infuraUrl : Config.ethereum.url);

let client = new Client({
    host: Config.bitcoind.host,
    port: Config.bitcoind.port,
    ssl: {
        enabled: Config.bitcoind.ssl,
        strict: false
    },
    agentOptions: {

    },
    username: "bitcoin",
    password: "bitcoin",
    network: "mainnet"
});

let btc = new BitcoinProvider(client, {
    host: Config.electrum.host,
    port: Config.electrum.port,
    ssl: Config.electrum.ssl
});

let contract = new StorageContract(web3, btc);
let infuraContract = new StorageContract(infuraWeb, btc);



let totalDeposit = 0;
let totalWithdrawn = 0;
let totalWithdrawnReferrers = 0;

let totalCurrentBalance = 0;
let totalCurrentReferrers = 0;

let totalFees = 0;

let pendingWithdrawals = [];
let allWithdrawals = [];

let bitcoinMapping = {};
let ethereumMapping = {};


function pad(n){return n<10 ? '0'+n : n}




//done like this cause it's too much load for local node

infuraContract.getInvestors().then(async (investors) => {
    let processed = [];
    let startTime = new Date();

    for (let i in investors) {
        try {
            let account = await InvestorAccount.fromEthereumAddress(investors[i], contract);
            if (bitcoinMapping.hasOwnProperty(account.getBitcoinAddress())) {
                continue;
            }

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
                        }
                    }
                }
            }
            console.log((needsFullUpdate ? "full " : "==== small ") + account.getPublicKey());

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
                }
            }else{
                for (let txid in data.transactions) {
                    let tx = data.transactions[txid];
                    tx.related = oldAccount.transactions[txid].related;
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
                        totalCurrentReferrers += tx.balance;
                    } else {
                        totalCurrentBalance += tx.balance;
                    }
                } else {
                    if (tx.signature === "referer") {
                        totalWithdrawnReferrers += tx.balance;
                    } else {
                        totalWithdrawn += tx.balance;
                    }
                }

                totalDeposit += tx.value;
                totalFees += tx.fee;
            }

            if (isNaN(totalDeposit)) {
                console.log(data);
                process.exit(1)
                continue;
            }

            setAccountFile(account.getPublicKey(), data);

            processed.push(account.getEthereumAddress());

            console.log("Processed " + investors[i] + " [" + processed.length + "/" + investors.length + "]")
        } catch (e) {
            console.log(e)
        }
    }

    console.log("Total deposited: " + totalDeposit);
    console.log("Total withdrawn (deposits): " + totalWithdrawn);
    console.log("Total withdrawn (referrals): " + totalWithdrawnReferrers);
    console.log("Total balance (deposits): " + totalCurrentBalance);
    console.log("Total balance (referrals): " + totalCurrentReferrers);
    console.log("Total fees: " + totalFees);
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
            let entry = {
                rd: formatDate(date),
                btc: account.getBitcoinAddress(),
                eth: account.getEthereumAddress().toLowerCase(),
                tx: (tx.signature === "referer" ? "REFERRER" : tx.txid),
                v: tx.balance.toFixed(8),
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
            }

            csv += (formatDate(date) + ", " + account.getBitcoinAddress() + ", " + account.getEthereumAddress().toLowerCase() + ", " + (tx.signature === "referer" ? "REFERRER" : tx.txid) + ", " + tx.balance.toFixed(8) + ", " + paidOut + ", " + relatedTx + ", " + delay + "\r\n");
        }

        processedEntries.sort((a, b) => {
            return b.exit_timestamp - a.exit_timestamp;
        })

        for (let i in processedEntries) {
            delete processedEntries[i].exit_timestamp;
        }


        fs.writeFile(path.resolve("web", "withdrawEntries.json"), JSON.stringify(withdrawEntries), () => {
        });
        fs.writeFile(path.resolve("web", "pendingEntries.json"), JSON.stringify(pendingEntries), () => {
        });
        fs.writeFile(path.resolve("web", "processedEntries.json"), JSON.stringify(processedEntries), () => {
        });
        fs.writeFile(path.resolve("web", "latest.csv"), csv, () => {
        });


        fs.writeFile(path.resolve("index", "bitcoinMapping.json"), JSON.stringify(bitcoinMapping, null, " "), () => {
        });
        fs.writeFile(path.resolve("index", "ethereumMapping.json"), JSON.stringify(ethereumMapping, null, " "), () => {
        });
        fs.writeFile(path.resolve("index", "pendingWithdrawals.json"), JSON.stringify(pendingWithdrawals, null, " "), () => {
        });
    }

});

