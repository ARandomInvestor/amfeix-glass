'use strict';

export default {
    bitcoind: {
        //Requires -txindex=1 set
        host: "127.0.0.1",
        port: 8332,
        ssl: false
    },
    electrum: {
        //For example, electrs
        host: "127.0.0.1",
        port: 50001,
        ssl: false
    },
    ethereum: {
        url: "http://127.0.0.1:8545",
        infuraUrl: "https://mainnet.infura.io/v3/INFURA_API_KEY"
    }
}