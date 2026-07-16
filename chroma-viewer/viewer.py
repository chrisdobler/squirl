import os

import chromadb
import streamlit as st

CHROMA_HOST = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8000"))

st.set_page_config(page_title="Squirl ChromaDB", page_icon="🐿", layout="wide")
st.title("Squirl ChromaDB")
st.caption(f"Connected to {CHROMA_HOST}:{CHROMA_PORT}")

try:
    client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
    collections = client.list_collections()
except Exception as error:
    st.error(f"Could not connect to ChromaDB at {CHROMA_HOST}:{CHROMA_PORT}: {error}")
    st.stop()

if not collections:
    st.info("ChromaDB is connected, but it does not contain any collections yet.")
    st.stop()

collection_names = [
    collection if isinstance(collection, str) else collection.name
    for collection in collections
]
selected_name = st.selectbox("Collection", collection_names)
collection = client.get_collection(selected_name)
record_count = collection.count()

count_column, page_size_column, page_column = st.columns(3)
count_column.metric("Records", record_count)
page_size = page_size_column.selectbox("Rows per page", [10, 25, 50, 100], index=1)
page_count = max(1, (record_count + page_size - 1) // page_size)
page = page_column.number_input("Page", min_value=1, max_value=page_count, value=1)

if record_count == 0:
    st.info("This collection is empty.")
    st.stop()

records = collection.get(
    limit=page_size,
    offset=(page - 1) * page_size,
    include=["documents", "metadatas"],
)

ids = records.get("ids") or []
documents = records.get("documents") or []
metadatas = records.get("metadatas") or []
rows = [
    {
        "id": record_id,
        "document": documents[index] if index < len(documents) else None,
        "metadata": metadatas[index] if index < len(metadatas) else None,
    }
    for index, record_id in enumerate(ids)
]

st.dataframe(rows, width="stretch", hide_index=True)

with st.expander("Raw response"):
    st.json(records)
