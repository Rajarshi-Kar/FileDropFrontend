let ws = null;
let roomKey = null;
let roomCode = null;
let alias = null;
let messageCount = 0;
let pendingFile = null;

function bytesToBase64(bytes) {
    return btoa(String.fromCharCode(...bytes));
}
function base64ToBytes(b64) {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function generateRoomCode() {
    return Math.random().toString(36).slice(2, 10);
}

async function encryptText(key, message) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(message);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
    return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

async function decryptText(key, ciphertext, iv) {
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(iv) },
        key,
        base64ToBytes(ciphertext)
    );
    return new TextDecoder().decode(decrypted);
}

function connectSocket() {
    ws = new WebSocket("wss://rypo8sd6h9.execute-api.us-east-1.amazonaws.com/prod?room=" + roomCode);

    ws.onmessage = async e => {
        const data = JSON.parse(e.data);

        if (data.presignUrl && pendingFile) {
            await fetch(data.presignUrl, {
                method: "PUT",
                body: pendingFile.blob
            });

            const payload = {
                type: "file",
                sender: alias,
                name: pendingFile.name,
                iv: pendingFile.iv,
                key: pendingFile.key,
                url: data.fileUrl
            };

            ws.send(JSON.stringify(payload));
            receiveFile(payload);

            pendingFile = null;
            return;
        }

        if (data.type === "rotate") {
            const decrypted = await decryptText(roomKey, data.ciphertext, data.iv);
            const raw = base64ToBytes(decrypted);

            roomKey = await crypto.subtle.importKey(
                "raw",
                raw,
                { name: "AES-GCM" },
                true,
                ["encrypt", "decrypt"]
            );
            return;
        }

        if (data.type === "system") {
            addSystemMessage(data.text);
            return;
        }

        if (data.type === "count") {
            document.getElementById("participantCount").innerText =
                data.value + " participant" + (data.value === 1 ? "" : "s") + " connected";
            return;
        }

        if (data.type === "file") {
            receiveFile(data);
            return;
        }

        if (!data.ciphertext) return;

        const decrypted = await decryptText(roomKey, data.ciphertext, data.iv);
        const payload = JSON.parse(decrypted);
        appendMessage(payload.sender, payload.text, false);

    };
}

async function sendMessage() {
    if (!ws || ws.readyState !== 1) return;

    const input = document.getElementById("msgInput");
    const msg = input.value.trim();
    if (!msg) return;

    const payload = { sender: alias, text: msg };
    const encrypted = await encryptText(roomKey, JSON.stringify(payload));

    ws.send(JSON.stringify(encrypted));
    messageCount++;
    if (messageCount >= 20){
        rotateKey();
        messageCount = 0;
    }
    appendMessage(alias, msg, true);
    input.value = "";
}

async function encryptFile(file) {
    const fileKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const buffer = await file.arrayBuffer();

    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        fileKey,
        buffer
    );

    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", fileKey));
    const encKey = await encryptText(roomKey, bytesToBase64(raw));

    return {
        blob: new Blob([encrypted]),
        iv: bytesToBase64(iv),
        key: encKey,
        name: file.name
    };

}

function appendMessage(sender, text, mine) {
    const box = document.getElementById("messages");
    const wrap = document.createElement("div");
    wrap.className = mine ? "msg mine" : "msg theirs";

    const name = document.createElement("div");
    name.className = "alias";
    name.innerText = sender;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerText = text;

    wrap.appendChild(name);
    wrap.appendChild(bubble);
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
}

async function sendFile() {
    const file = document.getElementById("fileInput").files[0];
    if (!file) return;

    pendingFile = await encryptFile(file);

    ws.send(JSON.stringify({
        type: "presign",
        name: pendingFile.name
    }));
}


function receiveFile(data) {
    const box = document.getElementById("messages");

    const mine = data.sender === alias;

    const wrap = document.createElement("div");
    wrap.className = mine ? "msg mine" : "msg theirs";

    const name = document.createElement("div");
    name.className = "alias";
    name.innerText = data.sender || "Someone";

    const card = document.createElement("div");
    card.className = "bubble";
    card.innerHTML = `
        <div class="text-sm mb-1">${data.name}</div>
        <button class="bg-accent px-3 py-1 rounded text-xs">Download</button>
    `;

    card.querySelector("button").onclick = async () => {
        const res = await fetch(data.url);
        const buf = await res.arrayBuffer();

    const rawKey = await decryptText(roomKey, data.key.ciphertext, data.key.iv);

    const fileKey = await crypto.subtle.importKey(
        "raw",
        base64ToBytes(rawKey),
        { name: "AES-GCM" },
        true,
        ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(data.iv) },
        fileKey,
        buf
    );


        const blob = new Blob([decrypted]);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = data.name;
        a.click();
    };

    wrap.appendChild(name);
    wrap.appendChild(card);
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
}

async function rotateKey() {
    const newKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );

    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", newKey));
    const newKeyB64 = bytesToBase64(raw);

    const encrypted = await encryptText(roomKey, newKeyB64);

    ws.send(JSON.stringify({
        type: "rotate",
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv
    }));

    roomKey = newKey;
}

async function createRoom() {
    showChat();
    alias = prompt("Enter your alias");
    if (!alias) return;

    roomCode = generateRoomCode();
    roomKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", roomKey));
    const keyB64 = bytesToBase64(raw);

    const link = `${location.origin}${location.pathname}?room=${roomCode}#${keyB64}`;
    history.replaceState({}, "", link);
    document.getElementById("shareLink").innerText = link;
    document.getElementById("shareLinkModal").innerText = link;

    connectSocket();
}

async function autoJoin() {
    const params = new URLSearchParams(location.search);
    const hash = location.hash.slice(1);

    if (!params.has("room") || !hash) return;

    roomCode = params.get("room");

    showChat();

    alias = prompt("Enter your alias");
    if (!alias) return;

    roomKey = await crypto.subtle.importKey(
        "raw",
        base64ToBytes(hash),
        { name: "AES-GCM" },
        true,
        ["encrypt", "decrypt"]
    );

    document.getElementById("shareLink").innerText = location.href;
    document.getElementById("shareLinkModal").innerText = location.href;

    connectSocket();
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("createBtn")?.addEventListener("click", createRoom);
    document.getElementById("sendBtn")?.addEventListener("click", sendMessage);
    const msgInput = document.getElementById("msgInput");
    if (msgInput) {
        msgInput.addEventListener("keydown", e => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }
    const fileBtn = document.getElementById("fileBtn");
    const fileInput = document.getElementById("fileInput");
    if (fileBtn && fileInput) {
        fileBtn.onclick = () => fileInput.click();
        fileInput.onchange = sendFile;
    }

    autoJoin();
});


