console.log("1")
require('babel-register')({
    presets: [ 'env' ]
})
console.log("2")
import * as _ from "lodash";
console.log("3")
import { Context, Callback } from "aws-lambda";
console.log("4")
import { models } from "./models/index"; // DIES GOING TO GET MODELS
console.log("5")
import {
  VCStateUpdateAttributes,
  VCStateUpdateInstance,
} from "./models/interfaces/vcstateupdate-interface";
console.log("6")
require('dotenv').config()
console.log("7")
const Sequelize = require('sequelize');
console.log("8")
const op = Sequelize.Op;
console.log("9")
const fs = require('fs') // for reading contract abi
console.log("10")
var Web3 = require('web3')
console.log("11")
// web3 = new Web3(Web3.givenProvider || new Web3.providers.WebsocketProvider("wss://rinkeby.infura.io/_ws"))
var web3 = new Web3(new Web3.providers.HttpProvider("https://rinkeby.infura.io/v3/a81caafee3aa481ea334e50bb1826326"))
console.log("12")
var AWS = require('aws-sdk')
console.log("13")
// var myCredentials = new AWS.Credentials(process.env.AWS_KEY, process.env.AWS_SECRET_KEY)
console.log("3")
var sqs = new AWS.SQS({
    // apiVersion: '2012-11-05',
    // credentials: myCredentials,
    // region: "none",
    endpoint: process.env.SQS_ENDPOINT
});
console.log("4")
const docClient = new AWS.DynamoDB.DocumentClient({
    region: 'us-east-2',
    endpoint: 'https://dynamodb.us-east-2.amazonaws.com'
})
console.log("5")
// Add vcStateUpdate from http request to postgres db
export async function vcStateUpdate(event, context, callback) {
  const update = JSON.parse("Event: "+ event.body)
  docClient.put({
    TableName: "VCStateUpdate",
    Item: {
      eventType: "DidVCSettle",
      vcid: event.pathParameters.vcid,
      nonce: update.nonce,
      balanceA: update.balanceA,
      balanceB: update.balanceB,
      sig: update.sig
    }
  })

  callback(null, {
    statusCode: 200,
    headers: {
      "x-custom-header" : "My Header Value"
    },
    body: "databased returned: " + JSON.stringify(e)
  });
};

// TODO: handle lcStateUpdate function
// export async function lcStateUpdate(event, context, callback) {
//
// }

// catchEvents gets hub contract events and stores them in ContractEvents DB
export async function catchEvents (event, context, callback) {
  var lastBlock = 0 // TODO: what do we want for production??

  try {
    console.log("BANG")
    docClient.query({
      TableName: "LastBlock",
      FilterExpression: '#lb gt :b',
      ExpressionAttributeNames: {
        '#lb': "lastBlock"
      },
      ExpressionAttributeValues: {
        ':b': 0
      }
    }, function(err, data) {
      if (err) console.log(err, err.stack)
      else {
        console.log(data)
        lastBlock = data
      }
    })

    console.log("BOOM")
    callback(null, {
      statusCode: 200,
      headers: {
        "x-custom-header" : "My Header Value"
      },
      body: "GOTTTTTEEMMMM"
    });
  }
  catch (error) {
    console.log("READ ERROR")
    console.log(error)
  }

  console.log("LastBlock: " + lastBlock)

  // get most recent block
  var blockNumber = await web3.eth.getBlockNumber(function(err, res) {
    return res
  })
  console.log("Blocknumber: "+ blockNumber)

  const contractAddress = process.env.CONTRACT_ADDRESS
  console.log("Contract Address: " + contractAddress)
  const contract = JSON.parse(fs.readFileSync(__dirname + '/LedgerChannel.json', 'utf8'))
  // const contract = process.env.CONTRACT_JSON
  const eventFinder = new web3.eth.Contract(contract.abi, contractAddress)

  // Query contract for DidVCSettle events between last block checked and now
  eventFinder.getPastEvents("DidVCSettle", {
    filter: {},
    fromBlock: lastBlock,
    toBlock: blockNumber
  }, function(error, events){ console.log(events) })
  .then(async function(events) {
    // Add each of these events to the ContractEvents database
    /// Add each of these events to ContractEvents Queue
    for (var i in events){
      console.log(event[i])
      // Format and send SQS message
      sqsMessageFrom(events[i])
    }
  })
  console.log("Done with events.")

  // TODO: add the same functionality for lcstateupdate


  // update LastBlock table to hold lastest polled block
  // TODO: CHANGE TO UPDATE INSTEAD?
  docClient.put({
    TableName: "LastBlock",
    Item: {
      lastBlock: parseInt(event.pathParameters.block)
    }
  }, function(err, data) {
    if (err) {
      console.log("UPDATE LAST BLOCK ERROR")
      console.log(err, err.stack)
    }
    else console.log(data)
  })
}

// challengeEvent receives an event from ContractEvents Queue,
// checks if a higher nonce state update exists for that virtual channel,
// and then makes a dispute on chain if one does exist
export async function challengeEvent(message, context, callback) {
  // console.log("event body: " + event.Body)
  const dispute = JSON.parse(message.Body)
  const eventFields = JSON.parse(dispute.fields.StringValue)

  console.log(JSON.stringify(eventFields, null, 4))
  console.log("vcid: " + eventFields.returnValues.vcId)
  console.log("updateSeq: " + eventFields.returnValues.updateSeq)
  console.log("event: " + eventFields.event)
  try {
    // (1) look into DB for higher nonce vcstateupdate
    const proof = null
    docClient.query({
      TableName: "VCStateUpdates",
      FilterExpression: '#n gt :n and #v eq :vcid and #e eq :et',
      ExpressionAttributeNames: {
        '#n': "nonce",
        '#v': "vcId",
        '#e': "eventType"
      },
      ExpressionAttributeValues: {
        ':n': eventFields.returnValues.updateSeq,
        ':vcid': eventFields.returnValues.vcId,
        ':et': eventFields.event
      }
    }, function(err, data) {
      if (err) console.log(err, err.stack)
      else {
        console.log(data)
        proof = data
      }
    })

    // (2) if there is a proof, submit that
    if (proof) {
      // format and submit proof
      proof = proof.dataValues
      proof.lcid = eventFields.returnValues.lcId
      proof.partyA = eventFields.returnValues.partyA
      proof.partyB = eventFields.returnValues.partyB

      console.log("PROOF':" + JSON.stringify(proof, null, 4))
      disputeWithProof(proof)
    } else {
      console.log("NO PROOF")
    }
  } catch (error) {
    console.log(error)
  }
}

// disputeWithProof challenges with higher nonce state update
async function disputeWithProof(proof) {
  console.log("proof: " + proof)
  const contractAddress = process.env.CONTRACT_ADDRESS
  const contract = JSON.parse(fs.readFileSync('LedgerChannel.json', 'utf8'));
  const ChannelManager = new web3.eth.Contract(contract.abi, contractAddress)

  if (proof.eventType == "DidVCSettle") {
    // get challenger's signature
    const balanceA = Web3.utils.toBN(proof.balanceA)
    const balanceB = Web3.utils.toBN(proof.balanceB)
    const hubBond = balanceA.add(balanceB)
    const hash = web3.utils.soliditySha3(
      { type: 'bytes32', value: proof.vcid },
      { type: 'uint256', value: proof.nonce },
      { type: 'address', value: proof.partyA },
      { type: 'address', value: proof.partyB },
      { type: 'uint256', value: hubBond },
      { type: 'uint256', value: proof.balanceA },
      { type: 'uint256', value: proof.balanceB }
    )
    web3.eth.sign(hash, proof.partyA, function(error, sigA) {
      ChannelManager.methods.settleVC(
        proof.lcid,
        proof.vcid,
        proof.nonce,
        proof.partyA,
        proof.partyB,
        proof.balanceA,
        proof.balanceB,
        sigA
      ).send(
        {from: process.env.SENDER_ADDRESS}  // test address
      )
    })
  }
}

// createSQSMessageFrom constructs an SQS message from a blockchain event
async function sqsMessageFrom(event) {
  const attributes = JSON.stringify({
    "ts": {
      DataType: "String",
      StringValue: String(Date.now())
    },
    "blockNumber": {
      DataType: "String",
      StringValue: String(event.blockNumber)
    },
    "isValidBlock": {
      DataType: "Binary",
      BinaryValue: "true"
    },
    "sender": {
      DataType: "String",
      StringValue: String(event.address)
    },
    "eventType": {
      DataType: "String",
      StringValue: String(event.event)
    },
    "fields": {
      DataType:  "String",
      StringValue: JSON.stringify(event)
    }
  })
  const params = {
     DelaySeconds: 5,
     MessageAttributes: null,
     MessageBody: attributes,
     QueueUrl: process.env.SQS_URL
  };

  // Send message to SQS ContractEvent queue
  sqs.sendMessage(params, function(err, data) {
    if (err) {
      console.log("Error", err);
    } else {
      console.log("Success", data.MessageId);
    }
  })
}
