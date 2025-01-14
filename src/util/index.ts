import * as Sentry from "@sentry/node";
import { Request, Response } from "express";
import { messaging } from "firebase-admin";
import { ObjectID } from "mongodb";
import * as Mongo from "../modules/mongo";
import { parseId } from "../modules/mongo";
import { documentObject } from "../modules/mongo/baseTypes";
import { dispatchDelete, notify as socketNotify, OperationType } from "../modules/socket";
import { FriendLevel, friendReadCollections, getFriendLevel, isFriend, isTrustedFriend } from "../security";
import { parseForAllowedReadValues } from "../security/readRules";

import promclient from "prom-client"

export function transformResultForClientRead(value: documentObject, requestorUid: string) {

	parseForAllowedReadValues(value, requestorUid);

	const { _id, ...other } = value;
	return {
		exists: true,
		id: _id,
		content: other,
	};
}

const wait = (time: number): Promise<void> =>
	new Promise<void>((res) => setTimeout(res, time));

const counter  = new promclient.Counter({
	name: 'apparyllis_api_notifs',
	help: 'Counter for notifs sent'
});

const sendNotification = async (payload: {notification: {title: string, body: string}, data: {title: string, body: string}, token: string, }, uid: string) =>
{
	counter.inc()

	const privateCollection = Mongo.getCollection("private");
	
	const sendPayload = {...payload, apns:  {headers: {	"apns-expiration": "216000"}}}
	messaging()
		.send(sendPayload)
		.catch(async (error) => {
			if (error.code === "messaging/registration-token-not-registered") {
				const tokenToRemove = payload.token;
				privateCollection.updateOne({ uid: uid }, { $pull: { notificationToken: { tokenToRemove } } });
			} else if (error.code === "app/network-timeout" || error.code === "messaging/server-unavailable") {

				// Retry sending when it timed out
				await wait(1000);
				sendNotification(payload, uid)
				
			} else if (error.code === "messaging/invalid-argument") {
				Sentry.captureMessage("Error during notification: " + error + " " + JSON.stringify(payload));
			} else if (error.code !== "messaging/internal-error") {
				Sentry.captureMessage("Error during notification: " + error);
			}
		});
}

export const notifyUser = async (uid: string, title: string, message: string) => {
	socketNotify(uid, title, message);

	if (message.length > 1000)
	{
		message = message.substring(0, 999)
	}

	const privateCollection = Mongo.getCollection("private");
	const privateFriendData = await privateCollection.findOne({ uid: uid });
	if (privateFriendData) {
		privateCollection.updateOne({ uid, _id: uid }, {
			$push: {
				notificationHistory: {
					$each: [
						{
							timestamp: Date.now(),
							title,
							message
						}
					],
					$slice: -30
				},
			},
		});

		const token = privateFriendData["notificationToken"];
		if (Array.isArray(token)) {
			token.forEach((element) => {
				const payload = {
					notification: {
						title: title,
						body: message,
					},
					data: {
						title: title,
						body: message,
					},
					token: element,
					apns: {
						headers: {
							"apns-expiration": "216000"
						}
					}
				};

				sendNotification(payload, uid)
			});
		}
	}
};

export const getDocumentAccess = async (_req: Request, res: Response, document: documentObject, collection: string): Promise<{ access: boolean, statusCode: number, message: string }> => {
	if (document.uid == res.locals.uid) {
		return { access: true, statusCode: 200, message: "" }
	}
	else if (document.private && document.preventTrusted) {
		return { access: false, statusCode: 403, message: "Access to document has been rejected." }
	}
	else {
		if (friendReadCollections.indexOf(collection) < 0) {
			return { access: false, statusCode: 403, message: "Access to document has been rejected." }
		}

		const friendLevel: FriendLevel = await getFriendLevel(document.uid, res.locals.uid);
		const isaFriend = isFriend(friendLevel);
		if (!isaFriend) {
			if (collection === "users" && !!(friendLevel == FriendLevel.Pending)) {

				// Only send relevant data
				document = { uid: document.uid, _id: document._id, username: document.username, message: document.message }

				return { access: true, statusCode: 200, message: "" }
			}
			return { access: false, statusCode: 403, message: "Access to document has been rejected." }
		}
		else {
			if (document.private) {
				const trustedFriend: boolean = await isTrustedFriend(friendLevel);
				if (trustedFriend) {
					return { access: !document.preventTrusted, statusCode: 200, message: "" }
				}
				else {
					return { access: false, statusCode: 403, message: "Access to document has been rejected." }
				}
			}
			return { access: true, statusCode: 200, message: "" }
		}
	}
}

export const sendDocuments = async (req: Request, res: Response, collection: string, documents: documentObject[]) => {

	const returnDocuments: any[] = [];

	for (let i = 0; i < documents.length; ++i) {
		const access = await getDocumentAccess(req, res, documents[i], collection);
		if (access.access === true) {
			returnDocuments.push(transformResultForClientRead(documents[i], res.locals.uid));
		}
	}

	res.status(200).send(returnDocuments);
}

export const sendDocument = async (req: Request, res: Response, collection: string, document: documentObject) => {
	if (!document) {
		res.status(404).send();
		return;
	}

	const access = await getDocumentAccess(req, res, document, collection);
	if (access.access === true) {
		res.status(200).send(transformResultForClientRead(document, res.locals.uid));
		return;
	}
	res.status(access.statusCode).send(access.message);
}

export const fetchSimpleDocument = async (req: Request, res: Response, collection: string) => {
	const document = await Mongo.getCollection(collection).findOne({ _id: parseId(req.params.id), uid: req.params.system ?? res.locals.uid });
	sendDocument(req, res, collection, document);
}

export const deleteSimpleDocument = async (req: Request, res: Response, collection: string) => {
	const result = await Mongo.getCollection(collection).deleteOne({
		_id: parseId(req.params.id), uid: res.locals.uid, $or: [
			{ lastOperationTime: null },
			{ lastOperationTime: { $lte: res.locals.operationTime } }
		]
	});
	if (result.deletedCount && result.deletedCount > 0) {
		dispatchDelete({
			operationType: OperationType.Delete,
			uid: res.locals.uid,
			documentId: req.params.id,
			collection: collection
		})
		res.status(200).send();
	} else {
		res.status(404).send();
	}
}

export type forEachDocument = (document: any) => Promise<void>;

export const fetchCollection = async (req: Request, res: Response, collection: string, findQuery: { [key: string]: any }, forEach?: forEachDocument) => {
	findQuery.uid = req.params.system ?? res.locals.uid;
	const query = Mongo.getCollection(collection).find(findQuery)

	if (req.query.limit) {
		query.limit(Number(req.query.limit))
	}

	if (req.query.sortBy && req.query.sortOrder) {
		const sortQuery: any = {}
		const sortString: string = req.query.sortBy.toString()
		sortQuery[sortString] = Number(req.query.sortOrder)
		query.sort(sortQuery)
	}
	else {
		query.sort({ name: 1 })
	}

	if (req.query.start) {
		query.skip(Number(req.query.start))
	}

	const documents = await query.toArray();

	if (forEach) {
		for (let i = 0; i < documents.length; ++i) {
			await forEach(documents[i])
		}
	}

	sendDocuments(req, res, collection, documents);
}

export const addSimpleDocument = async (req: Request, res: Response, collection: string) => {
	const dataObj: documentObject = req.body;
	dataObj._id = res.locals.useId ?? new ObjectID();
	dataObj.uid = res.locals.uid;
	dataObj.lastOperationTime = res.locals.operationTime;
	const result = await Mongo.getCollection(collection).insertOne(dataObj).catch(() => {
		return {
			insertedId: "",
			acknowledged: false
		}
	});

	if (result.insertedId.toString().length <= 0) {
		res.status(500).send("Server processed your request, however was unable to enter a document into the database");
		return;
	}

	res.status(200).send(result.insertedId);
}

export const updateSimpleDocument = async (req: Request, res: Response, collection: string) => {
	const dataObj: documentObject = req.body;
	dataObj.uid = res.locals.uid;
	dataObj.lastOperationTime = res.locals.operationTime;
	await Mongo.getCollection(collection).updateOne({
		_id: parseId(req.params.id), uid: res.locals.uid, $or: [
			{ lastOperationTime: null },
			{ lastOperationTime: { $lte: res.locals.operationTime } }
		]
	}, { $set: dataObj });

	res.status(200).send();
}

export const isMember = async (uid: string, id: string) => {
	const member = await Mongo.getCollection("members").findOne({ uid, _id: parseId(id) })
	return !!member
}

export const isCustomFront = async (uid: string, id: string) => {
	const cf = await Mongo.getCollection("frontStatuses").findOne({ uid, _id: parseId(id) })
	return !!cf
}

export const isMemberOrCustomFront = async (uid: string, id: string) => {
	return (await isMember(uid, id)) || (await isCustomFront(uid, id))
}