import streamlit as st
import chromadb
import os

client = chromadb.HttpClient(
    host=os.environ.get("CHROMA_HOST", "localhost"),
    port=int(os.environ.get("CHROMA_PORT", "8000")),
)

st.title("Chroma Viewer")

collections = client.list_collections()

for c in collections:
    st.subheader(c.name)
    data = c.get(limit=5)
    st.write(data)
