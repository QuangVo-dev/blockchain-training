const cluster = require('cluster')
const dgram = require('dgram')
const crypto = require('crypto')
const assert = require('assert')
var ip = require('ip')
var fs = require('fs');
const express = require('express')
const parser = require('body-parser')
const request = require('request')
const axios = require('axios')

const lastOf = list => list[list.length - 1]


class Block {

  constructor(index, previousHash, timestamp, data) {
    this.index = index
    this.previousHash = previousHash
    this.timestamp = timestamp
    this.data = data
    this.nonce = 0
    this.hash = this.calculateHash()
  }

  calculateHash() {
    const { hash, ...data } = this
    return crypto
      .createHmac('sha256', JSON.stringify(data))
      .digest('hex')
  }

  static get GENESIS() {
    return new Block(
      0, '', 1522983367254, [], 0,
      'e063dac549f070b523b0cb724efb1d4f81de67ea790f78419f9527aa3450f64c'
    )
  }

  static fromPrevious({ index, hash }, data) {
    // Initialize next block using previous block and transaction data
    // assert(typeof hash === 'string' && hash.length === 64)
    return new Block(index + 1, hash, Date.now(), data, 0)
  }

  static fromJson({ index, previousHash, timestamp, data, nonce, hash }) {
    const block = new Block(index, previousHash, timestamp, data, nonce, hash)
    assert(block.calculateHash() === block.hash)
    return block
  }
}


class Server {

  constructor() {
    this.blocks = [Block.GENESIS]
    this.peers = {}
    this.state = {}
    this.pendingTransactions = {}

    this.peerServer = dgram.createSocket('udp4')
    this.peerServer.on('listening', this.onPeerServerListening.bind(this))
    this.peerServer.on('message', this.onPeerMessage.bind(this))

    this.httpServer = express()
    this.httpServer.use(parser.json())
    this.httpServer.get('/peers', this.showPeers.bind(this))
    this.httpServer.get('/blocks', this.showBlocks.bind(this))
    this.httpServer.post('/blocks', this.processBlocks.bind(this))
    this.httpServer.post('/transactions', this.processTransaction.bind(this))
    this.httpServer.post('/account', this.createAccount.bind(this))
    this.httpServer.get('/account', this.showState.bind(this))
    if (ip.address() == '172.28.0.2') {
      this.httpServer.get('/bootnode', this.getBootNode.bind(this))
    }

    // this.httpServer.get('/balance', this.getBalance.bind(this))
  }

  start() {
    if (!cluster.isMaster) return
    cluster.fork().on('online', _ => this.peerServer.bind(2346))
    cluster.fork().on('online', _ => this.httpServer.listen(2345, _ => {
      console.info('RPC server started at port 2345.')
    }))
    if (ip.address() != '172.28.0.2') {
      axios.get('http://172.28.0.2:2345/bootnode')
        .then((rs) => {
          this.blocks = rs.data.blocks
          this.state = rs.data.state
        })
    }
  }
  onPeerServerListening() {
    this.peerServer.setBroadcast(true)
    const address = this.peerServer.address()
    console.info(
      `Peer discovery server started at ${address.address}:${address.port}.`
    )

    setInterval(() => {
      this.peerServer.send('hello', address.port, '255.255.255.255', (err) => {
        if (err) console.log(err)
      })
    }, 1000)

    // TODO: broadcast the message to all the peers
  };

  onPeerMessage(message, remote) {
    // TODO: handle message from peers


    if (message.toString('utf8') == 'hello' && !this.peers[remote.address] && ip.address() != remote.address) {
      this.peers[remote.address] = remote
    }
  }

  showPeers(req, res) { res.json(this.peers) }
  showBlocks(req, res) { return res.json(this.blocks) }
  showState(req, res) {
    res.json(this.state)
  }
  getBootNode(req, res) {
    return res.json({ state: this.state, blocks: this.blocks })
  }
  // createSignature(msg, privateKey) {
  //   const sign = crypto.createSign('RSA-SHA256')
  //   sign.update(msg)
  //   return sign.sign(privateKey, 'hex')
  // }

  processTransaction(req, res) {
    var { fromAddress, toAddress, amount } = req.body
    // - Verify signature
    // let signature = this.createSignature(msg, privateKey)
    // const verify = crypto.createVerify('SHA256')
    // // if (verify.verify(fromAddress, signature)) {
    //   return res.send('You are not authorized, signature changed')
    // }
    // - Verify balance 
    if (!this.state[fromAddress]) {
      this.state[fromAddress] = 100
    }
    if (amount > this.state[fromAddress]) {
      return res.send('Not enough money')
    }

    // - Current block
    if (this.blocks.length === 1) {
      this.currentBlock = Block.fromPrevious(Block.GENESIS, Block.GENESIS.data)
    }
    if (this.blocks.length > 1) {
      this.currentBlock = Block.fromPrevious(lastOf(this.blocks), [])
    }
    // - Add transaction to block
    this.currentBlock.data.push({ fromAddress, toAddress, amount })
    // resonse
    res.send(`Transfer complete\n currentBlock: ${JSON.stringify(this.currentBlock, null, 2)}`)
    // - Check if we have waited for 30 seconds
    // - Proof-of-work
    while (!this.currentBlock.hash.startsWith('000')) {
      this.currentBlock.nonce += 1
      this.currentBlock.hash = this.currentBlock.calculateHash()
    }

    if (!this.state[toAddress]) {
      this.state[toAddress] = 100
    }
    this.state[fromAddress] -= amount
    this.state[toAddress] += amount
    this.blocks.push(this.currentBlock)

    Object.keys(this.peers).forEach(address => {
      // POST /blocks

      axios.post(`http://${address}:2345/blocks`, {
        block: JSON.stringify(this.currentBlock, null, 2)
      })
        .then(res => {
          console.log('success')
        })
        .catch(err => {
          if (err) {
            console.log('loi roi')
          }
        })
    })

  }


  processBlocks(req, res) {
    // TODO
    let lastBlock = this.blocks[this.blocks.length - 1]
    let currentBlock = JSON.parse(req.body.block)

    if (!currentBlock.hash.startsWith('000')) {
      return res.send('Block is not valid')

    }
    // if (currentBlock.hash !== currentBlock.calculateHash()) {
    //   return false
    // }
    if (currentBlock.previousHash !== lastBlock.hash) {
      return res.send('Block is not valid')
    }
    if (currentBlock.index <= lastBlock.index) {
      return res.send('Block is not valid')
    }
    if (!this.state[currentBlock.data[0].fromAddress]) {
      this.state[currentBlock.data[0].fromAddress] = 100
    }
    if (!this.state[currentBlock.data[0].toAddress]) {
      this.state[currentBlock.data[0].toAddress] = 100
    }
    this.state[currentBlock.data[0].fromAddress] -= currentBlock.data[0].amount
    this.state[currentBlock.data[0].toAddress] += currentBlock.data[0].amount

    this.blocks.push(currentBlock)
    return res.status(200).send('Block is valid')
  }

  createAccount(req, res) {
    // TODO
    // - Generate key pair based on password
    // - resonse
    // var input = req.body.password
    var input = req.body.password
    var password = crypto.createHmac('sha1', input).digest('hex');
    let diffHell = crypto.createDiffieHellman(password)
    diffHell.generateKeys('hex');
    publicKey = diffHell.getPublicKey('hex')

    this.state[diffHell.getPublicKey('hex')] = 100
    console.log(this.state)
    this.peerServer.send(`Account address_${publicKey}`,2346, '255.255.255.255', (err) => {
      if(err) {
        console.log(err)
      }
      console.log('Account created')
    })
    return res.send(`Wallet: ${diffHell.getPublicKey('hex')} Private Key ${diffHell.getPrivateKey('hex')}`)
  }

}
exports.Block = Block
exports.Server = Server
