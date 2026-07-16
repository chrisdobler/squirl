FROM searxng/searxng:latest

USER root
COPY settings.yml /etc/searxng/settings.yml
RUN chown searxng:searxng /etc/searxng/settings.yml
